import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Caller } from "./auth";

export type HandlerResponse = { status: ContentfulStatusCode; body: unknown };
/** A handler receives validated input and the caller; it returns { status, body }. */
export type Handler = (input: any, caller: Caller) => HandlerResponse | Promise<HandlerResponse>;
/** What each manifest action does, keyed by action name; createApp refuses to boot if a name is missing. */
export type Handlers = Record<string, Handler>;
