from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from shelf import pet


def test_pet_with_stub_modules(monkeypatch, tmp_path):
    monkeypatch.setenv('HOME', str(tmp_path))
    agent = ModuleType('agent'); agent.__path__ = []
    package = ModuleType('agent.pet'); package.__path__ = []
    package.constants = SimpleNamespace(DEFAULT_SCALE=.5, LOOP_MS=1200)
    package.store = SimpleNamespace(resolve_active_pet=lambda slug: SimpleNamespace(slug=slug, display_name='Pet', exists=True, spritesheet='unused'))
    render = ModuleType('agent.pet.render')
    class Renderer:
        def __init__(self, *args, **kwargs): pass
        def frame_count(self, state): return 10
        def cells(self, state, i, cols): return [[((1, 2, 3, 4), (5, 6, 7, 8))]]
    render.PetRenderer = Renderer
    for name, module in [('agent', agent), ('agent.pet', package), ('agent.pet.render', render)]: monkeypatch.setitem(sys.modules, name, module)
    assert pet.active({'display': {'pet': {'enabled': False}}})['reason'] == 'pet-disabled'
    config = {'display': {'pet': {'enabled': True, 'slug': 'pinned'}}}
    assert pet.active(config)['slug'] == 'pinned'
    result = pet.cells(config, 'bad', cols=100)
    assert result['state'] == 'idle' and result['cols'] == 48 and len(result['frames']) == 6
    assert not list(tmp_path.iterdir())


def test_unsupported_import(monkeypatch):
    monkeypatch.setitem(sys.modules, 'agent.pet', None)
    assert pet.active({})['reason'] == 'unsupported'
    assert pet.cells({}, 'idle')['enabled'] is False
