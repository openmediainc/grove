import { permanentRedirect } from "next/navigation";

/** The old raw skill.md dump; the human guide and the agent quickstart replaced it. */
export default function DocsPage() {
  permanentRedirect("/how-it-works");
}
