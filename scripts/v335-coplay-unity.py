#!/usr/bin/env python3
"""v3.3.5: Add coplay-mcp tools to Unity agents.

User reported scene-architect (and other Unity agents) had no access to
the coplay-mcp tools that operate the Unity Editor. Without them, those
agents can read files and run bash but cannot list the hierarchy, create
GameObjects, check compile errors, or do any of their actual jobs.

Per-agent curated subsets (vs. the full ~100-tool firehose):

  scene-architect — primary scene composition agent. Gets the full set:
    project state, hierarchy ops, components, prefabs, UI, scenes,
    materials (basic), capture/view, execute_script, terrain, play/stop.

  build-validator — compile and Play Mode validation. Compact subset:
    project state, check_compile_errors, play_game/stop_game, perf
    samplers, file inspection.

  shader-artist — shaders and materials. Subset:
    project state, all material/shader ops, 3D texture gen, image gen,
    file inspection.

  asset-manager — assets, packages, animations, media generation. Subset:
    project state, file/asset ops, package management, animation
    creation/inspection, 3D/audio/image generators, export, perf inspect.

Skipped:
  csharp-dev — sub-manager runs in Docker; cannot reach the Unity Editor
  in the first place. It already dispatches build-validator for Unity-side
  validation per the standard Unity task sequencing in scrum-master.

Run from repo root: python3 scripts/v335-coplay-unity.py
"""
import re
import os
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# ── Curated coplay subsets per agent ──────────────────────────────────────────

SCENE_ARCHITECT_COPLAY = [
    # Project state (universal)
    "list_unity_project_roots", "set_unity_project_root",
    "get_unity_editor_state", "get_unity_logs",
    # Hierarchy
    "list_game_objects_in_hierarchy", "get_game_object_info",
    "create_game_object", "delete_game_object", "duplicate_game_object",
    "parent_game_object", "rename_game_object",
    "set_transform", "set_rect_transform", "set_layer", "set_tag",
    "set_sibling_index", "set_property",
    # Components
    "add_component", "remove_component",
    "add_persistent_listener", "remove_persistent_listener",
    # Scenes
    "create_scene", "open_scene", "save_scene",
    # Prefabs
    "create_prefab", "create_prefab_variant", "add_nested_object_to_prefab",
    "list_all_prefabs_with_bounding_boxes", "place_asset_in_scene",
    # UI
    "create_ui_element", "set_ui_layout", "set_ui_text",
    # World
    "create_terrain",
    # Materials (basic — for assigning to GameObjects)
    "create_material", "assign_material",
    # File ops
    "list_files", "search_files", "rename_asset", "duplicate_asset", "read_file",
    # Visual capture
    "capture_scene_object", "capture_ui_canvas", "scene_view_functions",
    # Play mode
    "play_game", "stop_game",
    # Generic / utility
    "execute_script", "invoke_mcp_tool", "create_coplay_task",
]

BUILD_VALIDATOR_COPLAY = [
    "list_unity_project_roots", "set_unity_project_root",
    "get_unity_editor_state", "get_unity_logs",
    "check_compile_errors",
    "play_game", "stop_game",
    "get_worst_cpu_frames", "get_worst_gc_frames",
    "list_files", "search_files", "read_file",
    "list_code_definition_names",
]

SHADER_ARTIST_COPLAY = [
    "list_unity_project_roots", "set_unity_project_root",
    "get_unity_editor_state", "get_unity_logs",
    "create_material", "assign_material",
    "assign_material_to_fbx", "assign_shader_to_material",
    "generate_3d_model_texture", "generate_or_edit_images",
    "list_files", "search_files", "rename_asset", "duplicate_asset", "read_file",
]

ASSET_MANAGER_COPLAY = [
    # Project state
    "list_unity_project_roots", "set_unity_project_root",
    "get_unity_editor_state", "get_unity_logs",
    # File / asset ops
    "list_files", "search_files", "read_file",
    "rename_asset", "duplicate_asset",
    "list_objects_with_high_polygon_count",
    # Packages
    "install_unity_package", "install_git_package", "remove_unity_package",
    "list_packages", "search_all_packages", "search_installed_packages",
    # 3D / animations
    "auto_rig_3d_model", "apply_animation_to_rigged_model",
    "list_model_animation_clips", "search_animation_library",
    "create_animation_clip", "get_animation_clip_data", "set_animation_clip_settings",
    "create_animator_controller", "get_animator_controller_data", "modify_animator_controller",
    "create_blend_tree_state", "get_blend_tree_state_data",
    "set_animation_curves", "set_sprite_animation_curve",
    # Generators
    "generate_3d_model_from_image", "generate_3d_model_from_text",
    "generate_3d_model_texture",
    "generate_music", "generate_sfx", "generate_tts", "search_tts_voice_id",
    "generate_or_edit_images",
    # Input system
    "create_input_action_asset", "get_input_action_asset",
    "add_action_map", "remove_action_map",
    "add_action", "remove_action", "rename_action",
    "add_bindings", "remove_bindings", "add_composite_binding",
    "add_control_scheme", "remove_control_scheme",
    "generate_input_action_wrapper_code",
    # UI toolkit
    "create_panel_settings_asset",
    # Export
    "export_package",
]

PLAN = [
    ("scene-architect", SCENE_ARCHITECT_COPLAY),
    ("build-validator", BUILD_VALIDATOR_COPLAY),
    ("shader-artist", SHADER_ARTIST_COPLAY),
    ("asset-manager", ASSET_MANAGER_COPLAY),
]

with open("src/templates.js", "r", encoding="utf-8") as f:
    js = f.read()

for agent_key, coplay_tools in PLAN:
    # Build the full coplay tool string with mcp__coplay-mcp__ prefix
    coplay_str = ", ".join(f"mcp__coplay-mcp__{t}" for t in coplay_tools)

    # Find the agent's tools line
    m = re.search(
        r'(  "' + agent_key + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + agent_key +
        r'\ndescription:[^\n]*\ntools:\s*)([^\n]+)(\n---)',
        js
    )
    if not m:
        raise AssertionError(f"{agent_key}: tools-line anchor not found")
    old_tools = m.group(2)

    # Idempotent check: skip if any coplay tool already present
    if "mcp__coplay-mcp__" in old_tools:
        print(f"  {agent_key}: coplay tools already present (idempotent skip)")
        continue

    new_tools = f"{old_tools}, {coplay_str}"
    js = js[:m.start(2)] + new_tools + js[m.end(2):]
    print(f"  {agent_key}: {len(coplay_tools)} coplay tools added")

# ── Write + verify ────────────────────────────────────────────────────────────

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(js)

r = subprocess.run(["node", "--check", "src/templates.js"], capture_output=True, text=True)
if r.returncode != 0:
    print("SYNTAX ERROR:", r.stderr); sys.exit(1)
print("\nnode --check src/templates.js: OK")

r = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import('./src/templates.js').then(() => console.log('PARSE OK')).catch(e => { console.error(e.message); process.exit(1); })"],
    capture_output=True, text=True, timeout=15
)
if r.returncode != 0:
    print("PARSE ERROR:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# ── Final verification ────────────────────────────────────────────────────────

for agent_key, coplay_tools in PLAN:
    m = re.search(r'  "' + agent_key + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + agent_key +
                  r'\ndescription:[^\n]*\ntools:\s*([^\n]+)\n---', js)
    tools = m.group(1)
    coplay_count = tools.count("mcp__coplay-mcp__")
    expected = len(coplay_tools)
    assert coplay_count == expected, f"{agent_key}: expected {expected} coplay tools, got {coplay_count}"
    # Spot-check: a key Unity tool is present
    sample = coplay_tools[0]
    assert f"mcp__coplay-mcp__{sample}" in tools, f"{agent_key}: missing {sample}"
    print(f"Verified: {agent_key} has {coplay_count} coplay tools (expected {expected})")

print("\nSUCCESS: v3.3.5 — coplay tools added to 4 Unity agents")
