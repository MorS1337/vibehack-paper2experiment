import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppAPI, PiLoginMethod, PiLoginState, PiProvider } from '../../shared/types.js';
import { errorMessage } from '../lib/api.js';
import { Button, Select, TextInput } from './ui.js';

interface Props {
  api: AppAPI;
  disabled: boolean;
  onConnected: (provider: string, model: string) => void;
  onRefresh: () => Promise<void>;
}

export function PiLogin({ api, disabled, onConnected, onRefresh }: Props) {
  const [providers, setProviders] = useState<PiProvider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [method, setMethod] = useState<PiLoginMethod>('oauth');
  const [login, setLogin] = useState<PiLoginState | null>(null);
  const [value, setValue] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const session = useRef<string | null>(null);
  const mounted = useRef(false);
  const onConnectedRef = useRef(onConnected);
  const onRefreshRef = useRef(onRefresh);
  onConnectedRef.current = onConnected;
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    mounted.current = true;
    void api.piProviders().then(result => { if (mounted.current) setProviders(result); })
      .catch(cause => { if (mounted.current) setError(errorMessage(cause)); });
    return () => {
      mounted.current = false;
      if (session.current) void api.piLoginCancel(session.current).catch(() => undefined);
    };
  }, [api]);

  const pending = login?.status === 'pending';
  useEffect(() => {
    if (!pending || !login) return;
    let stopped = false;
    let timer: number;
    const update = async () => {
      try {
        const state = await api.piLoginState(login.id);
        if (stopped) return;
        setLogin(state);
        if (state.status !== 'pending') {
          session.current = null;
          setValue('');
        } else timer = window.setTimeout(() => void update(), 400);
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      }
    };
    timer = window.setTimeout(() => void update(), 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, login?.id, pending]);

  useEffect(() => {
    if (login?.status !== 'completed') return;
    let stopped = false;
    onConnectedRef.current(login.provider, '');
    void (async () => {
      try {
        const result = await api.piProviders();
        if (stopped) return;
        setProviders(result);
        await onRefreshRef.current();
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      }
    })();
    return () => { stopped = true; };
  }, [api, login?.id, login?.status]);

  useEffect(() => { setValue(''); }, [login?.prompt?.id]);
  const provider = providers.find(entry => entry.id === providerId);
  const chooseProvider = (id: string) => {
    setProviderId(id);
    setMethod(providers.find(entry => entry.id === id)?.methods[0]?.type ?? 'oauth');
    setLogin(null);
    setError('');
  };
  const start = async () => {
    setWorking(true); setError(''); setValue('');
    try {
      const state = await api.piLogin(providerId, method);
      if (!mounted.current) { await api.piLoginCancel(state.id); return; }
      session.current = state.id;
      setLogin(state);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { if (mounted.current) setWorking(false); }
  };
  const respond = async (event: FormEvent) => {
    event.preventDefault();
    if (!login?.prompt) return;
    const answer = value;
    setValue(''); setWorking(true); setError('');
    try {
      await api.piLoginRespond(login.id, login.prompt.id, answer);
      setLogin(current => current ? { ...current, prompt: undefined } : current);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setWorking(false); }
  };
  const cancel = async () => {
    if (!login) return;
    setWorking(true); setValue('');
    try {
      await api.piLoginCancel(login.id);
      setLogin(await api.piLoginState(login.id));
      session.current = null;
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setWorking(false); }
  };
  const open = (url: string) => {
    if (login) void api.openAuthLink(login.id, url).catch(cause => setError(errorMessage(cause)));
  };

  return <section className="card settings-form" aria-labelledby="pi-login-heading">
    <div className="card-head"><div className="card-title-group">
      <h2 id="pi-login-heading">Войти в Pi</h2>
      <p className="card-subtitle">Провайдеры и способы входа из Pi. Учётные данные сохраняются в auth storage Pi, не в эксперименте.</p>
    </div></div>
    <div className="settings-body">
      <div className="form-grid">
        <Select label="Провайдер входа" aria-label="Провайдер входа" value={providerId} disabled={disabled || working || pending} onChange={event => chooseProvider(event.target.value)}>
          <option value="">Выберите провайдера</option>
          {providers.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.configured ? ' · настроен' : ''}</option>)}
        </Select>
        <Select label="Способ входа" aria-label="Способ входа" value={method} disabled={disabled || working || pending || !provider?.methods.length} onChange={event => setMethod(event.target.value as PiLoginMethod)}>
          {provider?.methods.map(entry => <option key={entry.type} value={entry.type}>{entry.label}</option>)}
        </Select>
      </div>
      {provider && !provider.methods.length ? <p>У этого провайдера нет интерактивного входа. Настройте его штатные переменные окружения или внешние учётные данные.</p> : null}
      {!pending ? <Button disabled={disabled || working || !provider?.methods.length} loading={working} onClick={() => void start()}>Войти</Button> : null}
      {login?.notices.map((notice, index) => <div key={index} role="status">
        {notice.type === 'auth_url' ? <><p>{notice.instructions ?? 'Продолжите вход в браузере.'}</p><Button variant="secondary" onClick={() => open(notice.url)}>Открыть страницу входа</Button></> :
          notice.type === 'device_code' ? <><p>Код устройства: <strong>{notice.userCode}</strong></p><Button variant="secondary" onClick={() => open(notice.verificationUri)}>Открыть страницу подтверждения</Button></> :
            <><p>{notice.message}</p>{notice.type === 'info' ? notice.links?.map(link => <Button key={link.url} variant="secondary" onClick={() => open(link.url)}>{link.label ?? 'Открыть ссылку'}</Button>) : null}</>}
      </div>)}
      {pending && login.prompt ? <form className="form-section" onSubmit={event => void respond(event)} autoComplete="off">
        {login.prompt.type === 'select' ? <Select id="pi-login-answer" label={login.prompt.message} value={value} required onChange={event => setValue(event.target.value)}>
          <option value="">Выберите вариант</option>
          {login.prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}
        </Select> : <TextInput id="pi-login-answer" label={login.prompt.message} type={login.prompt.type === 'secret' || login.prompt.type === 'manual_code' ? 'password' : 'text'} value={value} placeholder={login.prompt.placeholder} onChange={event => setValue(event.target.value)} autoComplete="off" spellCheck={false} required />}
        <Button type="submit" disabled={working || !value}>Продолжить</Button>
      </form> : pending ? <p role="status">Ожидание провайдера…</p> : null}
      {pending ? <Button variant="secondary" disabled={working} onClick={() => void cancel()}>Отменить вход</Button> : null}
      {login?.status === 'completed' ? <div>
        <p role="status">Вход выполнен. Выберите модель и сохраните настройки ниже.</p>
        <Select label="Модель подключённого провайдера" aria-label="Модель подключённого провайдера" defaultValue="" disabled={disabled} onChange={event => onConnected(login.provider, event.target.value)}>
          <option value="">Выберите модель из каталога Pi</option>
          {providers.find(entry => entry.id === login.provider)?.models.map(model => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
        </Select>
      </div> : null}
      {login?.status === 'cancelled' ? <p role="status">Вход отменён или истекло время ожидания.</p> : null}
      {error || login?.error ? <p role="alert">{error || login?.error}</p> : null}
    </div>
  </section>;
}
