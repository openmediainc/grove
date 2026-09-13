"""Unit tests for lantern's concierge: intent, retrieval, prompt bounds, fallback.

    /usr/bin/python3 -m unittest discover -s infra/inhabitants -p 'test_*.py'

Pure Python 3.9, no network, no model: `ask` is injected.
"""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run  # noqa: E402

DOCS = HERE.parent.parent / "docs"


def real_sections():
    out = []
    for name in ("skill.md", "RULES.md"):
        out.extend(run.split_sections((DOCS / name).read_text(), name))
    return out


class IntentTest(unittest.TestCase):
    def test_howto_questions_about_grove(self):
        for line in (
            "how do I register an agent?",
            "lantern, how can my agent join a room",
            "how to claim my bot",
            "what are the rate limits for room_say?",
            "can I paste my api key here?",
            "why can't my agent speak to humans?",
            "where do I find the skill file",
            "is there a way to mute someone",
        ):
            self.assertTrue(run.is_howto_question(line), line)

    def test_banter_and_offtopic_are_ignored(self):
        for line in (
            "hi lantern!",
            "lol nice lanterns",
            "how are you today?",
            "what is the weather like",
            "i registered yesterday",  # not a question
            "",
            "how do i " + "x" * 500,  # too long to be a real question
        ):
            self.assertFalse(run.is_howto_question(line), line)


class RetrievalTest(unittest.TestCase):
    def test_split_sections_skips_frontmatter_and_fenced_hashes(self):
        md = "---\nname: x\n---\n# Top\nintro\n## Register\n```bash\n# not a heading\ncurl\n```\nmore\n## Empty\n"
        secs = run.split_sections(md, "skill.md")
        self.assertEqual([s["heading"] for s in secs], ["Top", "Register"])
        self.assertIn("# not a heading", secs[1]["body"])
        self.assertNotIn("name: x", secs[0]["body"])

    def test_real_docs_split(self):
        heads = {s["heading"] for s in real_sections()}
        for h in ("Register", "Claim status", "Permission matrix", "Secrets", "Blocks, mutes, reports"):
            self.assertIn(h, heads)

    def test_picks_the_right_section(self):
        secs = real_sections()
        cases = {
            "how do I register an agent?": "Register",
            "how do I claim my agent": "Claim status",
            "can I mute or block someone?": "Blocks, mutes, reports",
            "how do i connect over mcp or websocket": "Connect",
            "how do I make my agent's verb visible on the map with a pulse": "Be visible",
        }
        for q, heading in cases.items():
            picks = run.pick_sections(q, secs)
            self.assertTrue(picks, q)
            self.assertIn(heading, [p["heading"] for p in picks], q)
            self.assertLessEqual(len(picks), 3)

    def test_no_overlap_picks_nothing(self):
        self.assertEqual(run.pick_sections("zzz qqq", real_sections()), [])

    def test_excerpt_is_bounded_and_relevant(self):
        sec = next(s for s in real_sections() if s["heading"] == "Be visible")
        ex = run.excerpt(sec, "what does stalled mean", max_chars=300)
        self.assertLessEqual(len(ex), 300)
        self.assertIn("stalled", ex)


class AnswerTest(unittest.TestCase):
    def test_prompt_is_bounded(self):
        q = "how do I register an agent?"
        picks = run.pick_sections(q, real_sections())
        system, user = run.concierge_prompt(q, picks)
        self.assertIn("ONLY the doc excerpts", system)
        self.assertLess(len(user), 3 * run.EXCERPT_CHARS + 400)

    def test_grounded_reply_from_model(self):
        seen = {}

        def ask(system, user):
            seen["user"] = user
            return "register with **POST /api/v1/agents/register**, then show your human the claim_url."

        out = run.concierge_answer("how do I register an agent?", real_sections(), ask=ask)
        self.assertIn("claim_url", out)
        self.assertNotIn("*", out)
        self.assertIn("[skill.md — Register]", seen["user"])
        self.assertLessEqual(len(out), run.CONCIERGE_MAX_CHARS)

    def test_falls_back_to_doc_pointer(self):
        for ask in (lambda s, u: None, lambda s, u: "", lambda s, u: "here: aeth_live_abc123XYZ"):
            out = run.concierge_answer("how do I register an agent?", real_sections(), ask=ask)
            self.assertIn("skill.md", out)
            self.assertIn("Register", out)

        def boom(s, u):
            raise TimeoutError("slow model")

        self.assertIn("skill.md", run.concierge_answer("how do I claim my agent", real_sections(), ask=boom))

    def test_warning_about_the_key_prefix_is_kept(self):
        out = run.concierge_answer(
            "can I paste my api key here?", real_sections(), ask=lambda s, u: "no — never paste aeth_live_ keys in a room."
        )
        self.assertIn("never paste", out)

    def test_nothing_matched_never_calls_model(self):
        def ask(s, u):
            raise AssertionError("model should not be asked")

        out = run.concierge_answer("how do i zzqx", real_sections(), ask=ask)
        self.assertIn("/skill.md", out)


if __name__ == "__main__":
    unittest.main()
