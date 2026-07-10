"""
Thin YAML helper — keeps YAML handling optional so the package stays modular.
If PyYAML is unavailable, it transparently falls back to JSON. Imported lazily by
the memory/knowledge modules so depending on YAML is never forced.
"""


def _yaml():
    try:
        import yaml  # PyYAML
        return yaml, False
    except ImportError:
        import json
        return json, True


def load_yaml(path):
    from pathlib import Path
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    mod, is_json = _yaml()
    if is_json:
        return mod.loads(text)
    return mod.safe_load(text) or {}


def dump_yaml(data):
    mod, is_json = _yaml()
    if is_json:
        return mod.dumps(data, indent=2)
    return mod.safe_dump(data, sort_keys=False, allow_unicode=True, width=100000)
