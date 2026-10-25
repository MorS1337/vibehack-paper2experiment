import { AlertIcon, LockIcon, TerminalIcon } from './icons.js';

export function BridgeUnavailable() {
  return (
    <main className="bridge-page">
      <div className="bridge-card" aria-labelledby="bridge-title">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">P2E</span>
          <span>
            <span className="brand-title">Paper2Experiment</span>
            <span className="brand-sub">исследовательский стенд</span>
          </span>
        </div>

        <div className="bridge-heading">
          <span className="bridge-icon" aria-hidden="true">
            <LockIcon size={22} />
          </span>
          <div>
            <p className="eyebrow">Безопасный режим</p>
            <h1 id="bridge-title">Нативный мост недоступен</h1>
          </div>
        </div>

        <p className="bridge-lead">
          Страница открыта в браузере, но приложению нужен Electron-мост <code>window.paper2</code>.
          Этот интерфейс не подменяет данные и не запускает эксперименты без настольного процесса.
        </p>

        <div className="bridge-alert">
          <AlertIcon />
          <p>
            Запуски, файлы, микрофон и вычислители доступны только из Electron. Закройте эту вкладку и
            запустите приложение из каталога проекта.
          </p>
        </div>

        <section className="bridge-steps" aria-labelledby="bridge-steps-title">
          <h2 id="bridge-steps-title">Как открыть приложение</h2>
          <ol>
            <li>
              <span className="bridge-step-index">1</span>
              <div>
                <p>Соберите проект и запустите Electron:</p>
                <pre><code>npm run dev</code></pre>
              </div>
            </li>
            <li>
              <span className="bridge-step-index">2</span>
              <div>
                <p>Либо откройте уже собранное приложение:</p>
                <pre><code>npm start</code></pre>
              </div>
            </li>
            <li>
              <span className="bridge-step-index">3</span>
              <div>
                <p>
                  Дождитесь окна Paper2Experiment. Если мост не появился, проверьте журнал Electron и
                  preload-скрипт — без него безопасная работа с файлами невозможна.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <div className="bridge-security">
          <TerminalIcon />
          <p>
            Рендерер не импортирует Node.js или Electron напрямую. Все привилегированные действия идут
            через проверяемый IPC-мост, поэтому браузерный режим намеренно не поддерживается.
          </p>
        </div>
      </div>
    </main>
  );
}
