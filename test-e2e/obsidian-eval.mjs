// Evaluate an async JS expression inside a running Obsidian (CDP), print the JSON result.
//   node test-e2e/obsidian-eval.mjs 9444 'app.vault.getName()'
const [port, expression] = [process.argv[2], process.argv[3]];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const match = process.argv[4] ?? "";
const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://") && t.title.includes(match) && !t.title.startsWith("Settings"));
if(!page) {
    console.error("no Obsidian page target", targets.map((t) => t.url));
    process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
});
ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if(message.id !== 1) {
        return;
    }
    const result = message.result;
    if(result.exceptionDetails) {
        console.error("EXCEPTION", result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
        process.exitCode = 1;
    } else {
        console.log(typeof result.result.value === "string" ? result.result.value : JSON.stringify(result.result.value, null, 2));
    }
    ws.close();
};
ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: `(async () => { ${expression.includes("return") ? expression : `return (${expression});`} })()`, awaitPromise: true, returnByValue: true },
}));
