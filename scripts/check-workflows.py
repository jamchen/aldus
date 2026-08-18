#!/usr/bin/env python3
"""Validate the GitHub Actions workflow files.

A workflow GitHub cannot parse does not fail quietly. GitHub creates a failed run named by the
file path, on **every push to every branch**, because it cannot determine the triggers. That is
how a duplicate `inputs:` key in release.yml produced a stream of failure notifications with no
obvious cause: the file parsed fine with a permissive loader, which silently keeps the last of
two duplicate keys, so nothing local disagreed with it.

This checks the two things a permissive parse will not:

  - duplicate mapping keys anywhere in the document, which GitHub rejects outright;
  - `inputs.x` references naming an input no `workflow_dispatch` declares, which evaluate to
    empty on every run rather than failing.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the runner ships PyYAML
    print("PyYAML unavailable; skipping workflow validation", file=sys.stderr)
    raise SystemExit(0)


class StrictLoader(yaml.SafeLoader):
    """A loader that refuses duplicate keys instead of silently keeping the last."""


def _no_duplicates(loader: StrictLoader, node: yaml.MappingNode, deep: bool = False) -> dict:
    seen: set = set()
    result: dict = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.YAMLError(
                f'duplicate key "{key}" at line {key_node.start_mark.line + 1}'
            )
        seen.add(key)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates
)

problems: list[str] = []
workflows = sorted(Path(".github/workflows").glob("*.y*ml"))

for path in workflows:
    text = path.read_text()

    try:
        document = yaml.load(text, StrictLoader)
    except yaml.YAMLError as error:
        problems.append(f"{path}: {error}")
        continue

    # `on` is parsed as the boolean True by YAML 1.1, which PyYAML implements.
    triggers = document.get(True) or document.get("on") or {}
    dispatch = triggers.get("workflow_dispatch") or {}
    declared = set((dispatch.get("inputs") or {}).keys())
    used = set(re.findall(r"inputs\.([A-Za-z0-9_-]+)", text))

    for name in sorted(used - declared):
        problems.append(
            f"{path}: references inputs.{name}, which no workflow_dispatch input declares. "
            "It evaluates to empty on every run rather than failing."
        )

if problems:
    print("Workflow problems:\n", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    raise SystemExit(1)

print(f"Workflows OK ({len(workflows)} files).")
