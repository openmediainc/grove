// next/font/google only works inside the Next compiler. Tests that import a
// layout (for its metadata) get this stand-in: the variable class name only.
type FontOptions = { variable?: string };
function font(options: FontOptions = {}) {
  return { className: "", variable: options.variable ?? "", style: { fontFamily: "" } };
}
export const Schibsted_Grotesk = font;
export const Fragment_Mono = font;
