/** `GET /`: the hosted tip page. The scripts in `src/client` make it pay. */
import { html, raw } from "hono/html";
import { BACKGROUND, CUP, FOREGROUND, RADIUS } from "./brand.ts";
import { AGENTS_HEADLINE, example, howToTip, INVITATION } from "./invite.ts";
import type { Menu } from "./tips.ts";

const STYLE = `
:root { color-scheme: light dark; --page: #fbf7f1; --card: #fff; --text: #2a1a0a; --muted: #6b5a4a; --line: #e7dccd; }
@media (prefers-color-scheme: dark) {
  :root { --page: #17120e; --card: #221a14; --text: #f5ede4; --muted: #b9a999; --line: #3a2e24; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--page); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 520px; margin: 0 auto; display: grid; gap: 20px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
h1 { font-size: 26px; line-height: 1.2; margin: 12px 0 8px; }
h2 { font-size: 18px; margin: 0 0 8px; }
p { margin: 0 0 12px; }
a { color: inherit; }
.cup { width: 44px; height: 44px; padding: 9px; border-radius: 50%; background: ${BACKGROUND}; color: ${FOREGROUND}; }
.demo { border: 1px dashed var(--muted); border-radius: ${RADIUS}px; padding: 10px 12px; }
.muted, footer { color: var(--muted); font-size: 14px; }
fieldset { border: 0; margin: 16px 0 12px; padding: 0; display: flex; gap: 8px; flex-wrap: wrap; }
legend { padding: 0; margin-bottom: 8px; font-weight: 600; }
.amount { flex: 1; }
.amount input { position: absolute; opacity: 0; }
.amount span { display: block; text-align: center; white-space: nowrap; padding: 10px 12px; border: 2px solid var(--line); border-radius: ${RADIUS}px; font-weight: 600; cursor: pointer; }
.amount input:checked + span { border-color: ${BACKGROUND}; background: color-mix(in srgb, ${BACKGROUND} 22%, transparent); }
.amount input:focus-visible + span, button:focus-visible, a:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
button { width: 100%; padding: 13px 16px; border: 0; border-radius: ${RADIUS}px; background: ${BACKGROUND}; color: ${FOREGROUND}; font: inherit; font-weight: 700; cursor: pointer; transition: transform 0.15s ease; }
button:hover:enabled { transform: translateY(-1px); }
button:disabled { opacity: 0.6; cursor: progress; }
#status { margin: 12px 0 0; min-height: 1.5em; font-weight: 600; overflow-wrap: anywhere; }
pre { overflow-x: auto; margin: 0 0 12px; padding: 12px; border: 1px solid var(--line); border-radius: ${RADIUS}px; font-size: 12.5px; line-height: 1.45; }
footer { text-align: center; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } button:hover:enabled { transform: none; } }
`;

export function tipPage(menu: Menu, origin: string, requested: string | undefined) {
  const preferred = menu.amounts.find((tip) => tip.amount === requested);
  const selected = preferred ?? menu.amounts[Math.floor((menu.amounts.length - 1) / 2)];
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tip ${menu.author} a coffee</title>
    <meta name="description" content="${menu.message}" />
    <link rel="payment" type="application/json" href="${origin}/tip" title="x402 tip menu" />
    <link rel="help" type="text/plain" href="${origin}/llms.txt" title="How AI agents can tip" />
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <main>
      <section>
        <svg class="cup" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(CUP)}</svg>
        <h1>Tip ${menu.author} a coffee</h1>
        <p>${menu.message}</p>
        ${
          menu.demo &&
          html`<p class="demo"><strong>Demo mode, no funds move.</strong> Your tip is signed by a throwaway wallet made in this browser tab.</p>`
        }
        <form id="tip">
          <fieldset>
            <legend>Choose an amount</legend>
            ${menu.amounts.map(
              (tip) =>
                html`<label class="amount"><input type="radio" name="amount" value="${tip.amount}" ${tip === selected ? "checked" : ""} /><span>${tip.amount} ${menu.asset}</span></label>`,
            )}
          </fieldset>
          <p id="terms" class="muted"></p>
          <button type="submit">Tip</button>
          <p id="status" role="status"></p>
        </form>
        <noscript><p class="muted">Paying from a browser wallet needs JavaScript. The instructions for AI agents below work without it.</p></noscript>
      </section>
      <section id="agents">
        <h2>${AGENTS_HEADLINE}</h2>
        ${INVITATION.map((sentence) => html`<p>${sentence}</p>`)}
        <p class="muted">${howToTip(origin)}</p>
        <pre><code>${example(menu, origin)}</code></pre>
        <p class="muted">Full instructions: <a href="${origin}/llms.txt">${origin}/llms.txt</a>. The menu as JSON: <a href="${origin}/tip">${origin}/tip</a>.</p>
      </section>
      <footer>Tips settle through <a href="https://docs.atum.xyz">Atum</a> over x402. No account, no tracking.</footer>
    </main>
    <script type="application/json" id="menu">${raw(JSON.stringify(menu).replace(/</g, "\\u003c"))}</script>
    <script type="module" src="/tip.js"></script>
  </body>
</html>`;
}
