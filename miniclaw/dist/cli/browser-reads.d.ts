import { type Workspace } from "../workspace.js";
import { type ParsedArgs } from "./types.js";
/** Machine-readable result line on stdout; everything else goes to stderr. */
export declare const RESULT_MARKER = "KLEINCLAW_RESULT ";
interface ReadPage {
    goto(url: string, options?: {
        timeout?: number;
        waitUntil?: "load" | "domcontentloaded";
    }): Promise<void>;
    evaluate(pageFunction: string, arg?: unknown): Promise<unknown>;
    url: string;
}
export type OpenReadSession = (parsed: ParsedArgs, workspace: Workspace | null) => Promise<{
    page: ReadPage;
    close(): Promise<void>;
}>;
export declare function runMarketSearch(parsed: ParsedArgs, workspace: Workspace | null, openSession?: OpenReadSession): Promise<number>;
export declare function runMessages(parsed: ParsedArgs, workspace: Workspace | null, openSession?: OpenReadSession): Promise<number>;
export {};
