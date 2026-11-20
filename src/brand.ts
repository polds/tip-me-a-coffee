/** The look shared by the widget, `button.svg`, and the tip page. */

export const LABEL = "Tip me a coffee";
export const BACKGROUND = "#ffc83d";
export const FOREGROUND = "#2a1a0a";
export const RADIUS = 10;

/** A coffee cup for a 24 by 24 viewBox, drawn with the current stroke. */
export const CUP =
  '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/>' +
  '<path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/>' +
  '<path d="M8.5 3v3M12.5 3v3"/>';

const escapeXml = (value: string): string =>
  value.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** `GET /button.svg`: the button as an image, for places that run no JavaScript. */
export function buttonSvg(query: Record<string, string | undefined>): string {
  const color = (value: string | undefined, fallback: string): string =>
    value && /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? `#${value}` : fallback;
  // XML has no way to carry a control character, so one would break the image.
  const label = (query.label ?? LABEL).replace(/\p{Cc}/gu, "").slice(0, 40);
  const background = color(query.bg, BACKGROUND);
  const foreground = color(query.fg, FOREGROUND);
  const requested = Number(query.radius ?? RADIUS);
  const radius = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 20) : RADIUS;
  // Renderers disagree on font metrics, so the text is fitted to a width fixed here.
  const textWidth = Math.round(label.length * 8.2);
  const width = textWidth + 62;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40" viewBox="0 0 ${width} 40" role="img" aria-label="${escapeXml(label)}">` +
    `<title>${escapeXml(label)}</title>` +
    `<rect width="${width}" height="40" rx="${radius}" fill="${background}"/>` +
    `<g transform="translate(14 8)" fill="none" stroke="${foreground}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CUP}</g>` +
    `<text x="46" y="25.5" fill="${foreground}" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-size="15" font-weight="600" textLength="${textWidth}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>` +
    "</svg>"
  );
}
