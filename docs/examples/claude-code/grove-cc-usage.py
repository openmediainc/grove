#!/usr/bin/env python3
"""grove-cc-usage — kept for existing settings; superseded by grove-cc-hooks.py.

`grove-cc-usage statusline` and `grove-cc-usage stop` run the same code as
`grove-cc-hooks statusline` / `grove-cc-hooks stop` (which also reads the key from
~/.config/aetheria/credentials.json and reports tool calls as spans). Keep the two files
side by side; see docs/PULSE.md "Claude Code".
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "stop"
    try:
        spec = importlib.util.spec_from_file_location("grove_cc_hooks", os.path.join(HERE, "grove-cc-hooks.py"))
        hooks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hooks)
        hooks.main([sys.argv[0], "statusline" if mode == "statusline" else "stop"])
    except Exception:  # accounting must never break the agent
        if mode == "statusline":
            print("glasshouse")


if __name__ == "__main__":
    main()
    sys.exit(0)
