import { Harness } from "./harness.js";
import { Store } from "./store.js";
import { z } from "zod";

const port = process.parentPort;
if (!port)
  throw new Error("Harness должен запускаться как Electron utility process");
const root = process.argv[2];
if (!root) throw new Error("Не задана папка состояния");
const harness = new Harness(new Store(root));
const idSchema = z.string().uuid();
const ready = harness.initialize();
harness.onEvent((event) => port.postMessage({ kind: "event", event }));
harness.onConversation((update) =>
  port.postMessage({ kind: "conversation", update }),
);
port.on(
  "message",
  async ({
    data,
  }: {
    data: { id: number; method: string; args: unknown[] };
  }) => {
    const { id, method, args } = data;
    try {
      await ready;
      let result: unknown;
      switch (method) {
        case "snapshot":
          result = await harness.snapshot();
          break;
        case "create":
          result = await harness.create(args[0]);
          break;
        case "importPaper":
          result = await harness.importPaper(args[0]);
          break;
        case "setBrief":
          result = await harness.setBrief(idSchema.parse(args[0]), args[1]);
          break;
        case "sourcePdfPath":
          result = await harness.sourcePdfPath(idSchema.parse(args[0]));
          break;
        case "plan":
          result = await harness.plan(idSchema.parse(args[0]));
          break;
        case "savePlan":
          result = await harness.savePlan(idSchema.parse(args[0]), args[1]);
          break;
        case "execute":
          result = await harness.execute(idSchema.parse(args[0]));
          break;
        case "approve":
          result = harness.approve(idSchema.parse(args[0]));
          break;
        case "cancel":
          result = await harness.cancel(idSchema.parse(args[0]));
          break;
        case "cleanup":
          result = await harness.cleanup(idSchema.parse(args[0]));
          break;
        case "sendMessage":
          result = await harness.sendMessage(
            idSchema.parse(args[0]),
            z.string().min(1).max(30000).parse(args[1]),
            z.enum(["steer", "followUp"]).parse(args[2]),
            idSchema.optional().parse(args[3]),
          );
          break;
        case "conversation":
          result = harness.conversation(
            idSchema.parse(args[0]),
            z.number().int().nonnegative().optional().parse(args[1]),
          );
          break;
        case "artifactPreview":
          result = await harness.artifactPreview(
            idSchema.parse(args[0]),
            z.string().max(4096).parse(args[1]),
          );
          break;
        case "saveSettings":
          result = await harness.saveSettings(args[0]);
          break;
        case "piProviders":
          result = await harness.piAuth.providers();
          break;
        case "piLogin":
          result = harness.startPiLogin(
            z.string().min(1).max(200).parse(args[0]),
            z.enum(["api_key", "oauth"]).parse(args[1]),
          );
          break;
        case "piLoginState":
          result = harness.piAuth.state(idSchema.parse(args[0]));
          break;
        case "piLoginRespond":
          result = harness.piAuth.respond(
            idSchema.parse(args[0]),
            idSchema.parse(args[1]),
            z.string().max(32768).parse(args[2]),
          );
          break;
        case "piLoginCancel":
          result = await harness.piAuth.cancel(idSchema.parse(args[0]));
          break;
        case "authLink":
          result = harness.piAuth.authLink(
            idSchema.parse(args[0]),
            z.string().max(16384).parse(args[1]),
          );
          break;
        case "transcribe": {
          if (
            !(args[0] instanceof ArrayBuffer) ||
            args[0].byteLength > 2_000_000
          )
            throw new Error("Недопустимая запись; максимум 60 секунд PCM WAV");
          result = await harness.transcribe(args[0], idSchema.parse(args[1]));
          break;
        }
        case "cancelTranscription":
          result = await harness.cancelTranscription(idSchema.parse(args[0]));
          break;
        case "events":
          result = await harness.store.events(idSchema.parse(args[0]));
          break;
        case "folder":
          result = harness.store.get(idSchema.parse(args[0])).dir;
          break;
        case "shutdown":
          result = await harness.shutdown();
          break;
        default:
          throw new Error("Неизвестная операция");
      }
      port.postMessage({ kind: "response", id, result });
    } catch (error) {
      port.postMessage({
        kind: "response",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
ready
  .then(() => port.postMessage({ kind: "ready" }))
  .catch((error) => port.postMessage({ kind: "fatal", error: String(error) }));
