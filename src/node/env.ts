import { existsSync, readFileSync } from "node:fs";

// Loads ./.env (git-ignored) when present. Real environment variables win.
export function loadDotEnv(path = ".env"): void {
    if(existsSync(path)) {
        process.loadEnvFile(path);
    }
}

export function expertToken(): string {
    const file = process.env.EXPERT_TOKEN_FILE;
    return (process.env.EXPERT_TOKEN || (file && existsSync(file) ? readFileSync(file, "utf8") : "")).trim();
}
