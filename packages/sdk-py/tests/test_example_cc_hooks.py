"""docs/examples/claude-code/grove-cc-hooks.py: the payloads a Claude Code session sends."""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HOOKS = Path(__file__).resolve().parents[3] / "docs" / "examples" / "claude-code" / "grove-cc-hooks.py"
spec = importlib.util.spec_from_file_location("grove_cc_hooks", HOOKS)
hooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hooks)


class Builders(unittest.TestCase):
    def test_start_body_uses_tool_use_id_and_a_caption_not_the_command_line(self):
        body = hooks.start_body({
            "tool_use_id": "toolu_01ABC", "tool_name": "Bash",
            "tool_input": {"command": "curl -H 'Authorization: Bearer sk-live' x", "description": "fetch the page"},
        })
        self.assertEqual(body, {"call_id": "toolu_01ABC", "name": "Bash", "args": "fetch the page"})

    def test_bash_without_description_reports_only_the_program(self):
        body = hooks.start_body({"tool_use_id": "t1", "tool_name": "Bash",
                                 "tool_input": {"command": "  psql postgres://u:pw@h/db -c 'x'"}})
        self.assertEqual(body["args"], "psql")

    def test_captions_for_files_patterns_and_urls(self):
        self.assertEqual(hooks.span_caption({"file_path": "/Users/me/src/WorldMap.tsx"}), "WorldMap.tsx")
        self.assertEqual(hooks.span_caption({"pattern": "tool_calls\nmore"}), "tool_calls")
        self.assertEqual(hooks.span_caption({"url": "https://user:pw@example.com/a?token=1"}), "example.com")
        self.assertEqual(hooks.span_caption({"url": "https://docs.example.com/a?token=1"}), "docs.example.com")
        self.assertEqual(hooks.span_caption(None), "")

    def test_no_tool_use_id_means_no_span(self):
        self.assertIsNone(hooks.start_body({"tool_name": "Read"}))

    def test_ids_and_names_are_cleaned_to_what_the_server_accepts(self):
        self.assertEqual(hooks.clean_call_id("call id/with#junk"), "call_id_with_junk")
        self.assertEqual(len(hooks.clean_call_id("x" * 300)), 128)
        self.assertEqual(hooks.clean_tool_name("mcp__github__create_pr"), "mcp__github__create_pr")
        self.assertEqual(hooks.clean_tool_name("<b>"), "b")
        self.assertEqual(hooks.clean_tool_name(""), "tool")

    def test_trial_tag_rides_on_the_start(self):
        body = hooks.start_body({"tool_use_id": "t", "tool_name": "Bash"}, trial_id="tri_1")
        self.assertEqual(body["trial_id"], "tri_1")

    def test_finish_bodies(self):
        self.assertEqual(hooks.finish_body("post", {}), {"outcome": "ok"})
        self.assertEqual(hooks.finish_body("failure", {"error": "Exit code 1\nstack", "is_interrupt": False}),
                         {"outcome": "error", "result": "Exit code 1"})
        self.assertEqual(hooks.finish_body("failure", {"is_interrupt": True}),
                         {"outcome": "cancelled", "result": "cancelled"})

    def test_fallback_pulse_is_a_tool_pulse_with_the_same_caption(self):
        self.assertEqual(hooks.fallback_pulse({"name": "Read", "args": "a.ts"}), {"verb": "tool", "detail": "Read · a.ts"})

    def test_route_missing_only_for_a_framework_404(self):
        self.assertTrue(hooks.route_missing(404, {"message": "Route POST:/x not found", "statusCode": 404}))
        self.assertTrue(hooks.route_missing(404, None))
        self.assertFalse(hooks.route_missing(404, {"ok": False, "error": {"code": "NOT_FOUND"}}))
        self.assertFalse(hooks.route_missing(429, None))
        self.assertFalse(hooks.route_missing(None, None))


class Usage(unittest.TestCase):
    def transcript(self, lines):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "s.jsonl")
        with open(p, "w") as fh:
            fh.write("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
        return p

    def test_totals_count_each_message_id_once_and_include_subagents(self):
        msg = {"type": "assistant", "message": {"id": "msg_1", "model": "claude-x",
               "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_input_tokens": 100,
                         "cache_creation_input_tokens": 5}}}
        p = self.transcript([msg, msg, {"type": "user", "message": {"usage": {"input_tokens": 999}}},
                             {"type": "assistant", "message": {"id": "m0", "model": "<synthetic>", "usage": {"output_tokens": 9}}}])
        os.makedirs(p[:-6] + "/subagents")
        with open(p[:-6] + "/subagents/a.jsonl", "w") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"id": "msg_2", "model": "claude-x",
                                 "usage": {"input_tokens": 1, "output_tokens": 1}}}))
        self.assertEqual(hooks.transcript_totals(p), {"claude-x": {
            "input_tokens": 11, "output_tokens": 3, "cache_read_tokens": 100, "cache_write_tokens": 5}})

    def test_usage_body_is_cumulative_and_never_invents_a_cost(self):
        totals = {"claude-x": {"input_tokens": 1, "output_tokens": 2, "cache_read_tokens": 0, "cache_write_tokens": 0}}
        body = hooks.usage_body("s1", totals)
        self.assertEqual(body["reports"][0]["cumulative"], True)
        self.assertEqual(body["reports"][0]["session_id"], "s1")
        self.assertNotIn("cost_usd", body["reports"][0])
        self.assertEqual(hooks.usage_body("s1", totals, 0.25)["reports"][0]["cost_usd"], 0.25)
        two = dict(totals, **{"claude-y": totals["claude-x"]})
        split = hooks.usage_body("s1", two, 0.5)["reports"]
        self.assertEqual(len(split), 3)
        self.assertEqual(split[-1], {"session_id": "s1", "cumulative": True, "cost_usd": 0.5})
        self.assertIsNone(hooks.usage_body("s1", {}))


class Credentials(unittest.TestCase):
    def test_file_first_then_environment(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "c.json")
        with open(p, "w") as fh:
            json.dump({"api_key": "from-file", "api_base": "https://h.example/api/v1/"}, fh)
        self.assertEqual(hooks.load_credentials({"GROVE_CREDENTIALS": p, "AETHERIA_API_KEY": "env"}),
                         ("from-file", "https://h.example/api/v1"))
        self.assertEqual(hooks.load_credentials({"GROVE_CREDENTIALS": p + ".missing", "AETHERIA_API_KEY": "env"}),
                         ("env", "http://localhost:3000/api/v1"))


class Modes(unittest.TestCase):
    """The hook modes end to end with the transport stubbed: what is sent, in what order."""

    def setUp(self):
        self.sent = []
        self.answers = []
        cache = tempfile.mkdtemp()
        self.patches = [
            mock.patch.object(hooks, "CACHE", cache),
            mock.patch.object(hooks, "send", side_effect=self.fake_send),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def fake_send(self, path, body):
        self.sent.append((path, body))
        return self.answers.pop(0) if self.answers else (200, {"ok": True})

    def run_mode(self, mode, payload):
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))):
            hooks.main(["grove-cc-hooks", mode])

    def test_pre_then_post_opens_and_finishes_one_span(self):
        self.run_mode("pre", {"tool_use_id": "toolu_1", "tool_name": "Read", "tool_input": {"file_path": "/a/b.py"}})
        self.run_mode("post", {"tool_use_id": "toolu_1", "tool_name": "Read"})
        self.assertEqual(self.sent, [
            ("/world/tool-calls", {"call_id": "toolu_1", "name": "Read", "args": "b.py"}),
            ("/world/tool-calls/toolu_1/finish", {"outcome": "ok"}),
        ])

    def test_an_old_server_gets_pulses_instead(self):
        self.answers = [(404, {"message": "Route POST:/api/v1/world/tool-calls not found"})]
        self.run_mode("pre", {"tool_use_id": "toolu_2", "tool_name": "Bash", "tool_input": {"description": "build"}})
        self.run_mode("failure", {"tool_use_id": "toolu_2", "tool_name": "Bash", "error": "boom"})
        self.assertEqual([p for p, _ in self.sent], ["/world/tool-calls", "/world/pulse", "/world/pulse"])
        self.assertEqual(self.sent[1][1], {"verb": "tool", "detail": "Bash · build"})
        self.assertEqual(self.sent[2][1], {"verb": "error", "detail": "after Bash"})

    def test_stop_reports_usage_then_pulses_idle(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "t.jsonl")
        with open(p, "w") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"id": "m", "model": "claude-x",
                                 "usage": {"input_tokens": 3, "output_tokens": 4}}}))
        self.run_mode("stop", {"session_id": "sess", "transcript_path": p})
        self.assertEqual([x for x, _ in self.sent], ["/world/usage", "/world/pulse"])
        self.assertEqual(self.sent[0][1]["reports"][0]["input_tokens"], 3)
        self.assertEqual(self.sent[1][1], {"verb": "idle", "detail": "turn finished"})

    def test_garbage_on_stdin_never_raises(self):
        with mock.patch.object(sys, "stdin", io.StringIO("{nope")):
            hooks.main(["grove-cc-hooks", "pre"])
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
