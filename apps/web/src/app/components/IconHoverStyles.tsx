import { iconHoverCss } from "@/app/lib/icon-hover";

/**
 * Injects the reactive icon-hover stylesheet once, globally.
 *
 * Rendered from the root layout (a server component), so the CSS ships in the
 * initial HTML with no flash and no client cost. The stylesheet is compiled
 * from the registry in src/app/lib/icon-hover — edit icons there, not here.
 */
export default function IconHoverStyles() {
  return <style data-icon-hover dangerouslySetInnerHTML={{ __html: iconHoverCss }} />;
}
