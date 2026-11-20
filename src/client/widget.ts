/**
 * `<tip-me-a-coffee>`: a button that opens the hosted tip page. It only presents. The wallet
 * never runs inside the embedding page, so a reader's signature prompt always comes from the
 * tip server's own origin.
 */
import { BACKGROUND, CUP, FOREGROUND, LABEL, RADIUS } from "../brand.ts";
import { AGENTS_HEADLINE, howToTip, INVITATION } from "../invite.ts";

const STYLE = `
:host { display: inline-block; font: var(--tip-font, 600 15px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); }
[part="button"] { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px 10px 14px; border-radius: var(--tip-radius, ${RADIUS}px); background: var(--tip-bg, ${BACKGROUND}); color: var(--tip-fg, ${FOREGROUND}); text-decoration: none; box-shadow: 0 1px 2px rgb(0 0 0 / 0.25); transition: transform 0.15s ease, box-shadow 0.15s ease; }
[part="button"]:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); }
[part="icon"] { width: 20px; height: 20px; flex: none; }
:focus-visible { outline-offset: 3px; }
[part="agents"] { max-width: 34em; margin-top: 6px; font-size: 12px; font-weight: 400; line-height: 1.45; }
summary { width: fit-content; cursor: pointer; opacity: 0.8; }
p { margin: 6px 0 0; }
p a { color: inherit; }
@media (prefers-color-scheme: dark) { [part="button"] { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.16); } [part="button"]:hover { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.16), 0 4px 14px rgb(0 0 0 / 0.6); } }
@media (prefers-reduced-motion: reduce) { [part="button"] { transition: none; } [part="button"]:hover { transform: none; } }
`;

const TEMPLATE = `<style>${STYLE}</style>
<a part="button" target="_blank" rel="noopener">
  <svg part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CUP}</svg>
  <span part="label"></span>
</a>
<details part="agents">
  <summary>${AGENTS_HEADLINE}</summary>
  <p>${INVITATION.join(" ")}</p>
  <p><span></span> <a>How to tip</a></p>
</details>`;

class TipMeACoffee extends HTMLElement {
  static observedAttributes = ["label", "amount", "href"];

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    if (this.shadowRoot) this.render();
  }

  private render(): void {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    // The tip server is wherever this script was loaded from, unless `href` names another.
    const page = new URL(this.getAttribute("href") ?? "/", import.meta.url);
    const amount = this.getAttribute("amount");
    if (amount) page.searchParams.set("amount", amount);

    root.innerHTML = TEMPLATE;
    const [button, instructions] = root.querySelectorAll("a");
    const [label, how] = root.querySelectorAll("span");
    if (!button || !instructions || !label || !how) return;
    button.href = page.href;
    label.textContent = this.getAttribute("label") ?? LABEL;
    how.textContent = howToTip(page.origin);
    instructions.href = `${page.origin}/llms.txt`;
  }
}

customElements.define("tip-me-a-coffee", TipMeACoffee);
