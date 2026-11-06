// Written for mcp-forge tests in the shape of a Tauri v2 backend.
use std::process::Command;
use tauri::State;

const APP_CONTAINER: &str = "demo_app";
const INSPECT_FORMAT: &str = "{{.Id}}\x1e{{.State.Status}}";

pub(crate) fn run_docker(args: &[&str]) -> CommandResult { todo!() }
pub(crate) fn run_docker_status(args: &[&str]) -> CommandResult { todo!() }

#[tauri::command]
pub(crate) fn get_logs(lines: u32, state: State<'_, AppState>) -> CommandResult {
    let tail = format!("{}", lines);
    run_docker(&["logs", "--tail", &tail, APP_CONTAINER])
}

#[tauri::command]
pub(crate) fn inspect_app() -> Option<String> {
    let r = run_docker_status(&["inspect", "--format", INSPECT_FORMAT, APP_CONTAINER]);
    r.message.into()
}

#[tauri::command]
pub(crate) async fn stats_for(container_name: String) -> Option<String> {
    let format_str = "{{.CPUPerc}}||{{.MemPerc}}";
    run_docker(&["stats", "--no-stream", "--format", format_str, &container_name]).message.into()
}

#[tauri::command]
pub(crate) fn app_status() -> Status {
    status_by_name(APP_CONTAINER)
}

#[tauri::command]
pub(crate) fn single_status() -> Status {
    state_of(APP_CONTAINER)
}

fn status_by_name(name: &str) -> Status {
    let a = run_docker_status(&["inspect", "--format", "{{.State.Status}}", name]);
    let b = run_docker_status(&["ps", "--filter", name]);
    todo!()
}

fn state_of(name: &str) -> Status {
    run_docker_status(&["inspect", "--format", "{{.State.Status}}", name]).into()
}

#[tauri::command]
pub(crate) fn stop_app() -> CommandResult {
    run_docker(&["stop", APP_CONTAINER])
}

#[tauri::command]
pub(crate) fn logs_then_write(lines: u32) -> CommandResult {
    std::fs::write("/tmp/x", "y").ok();
    run_docker(&["logs", APP_CONTAINER])
}

#[tauri::command]
pub(crate) fn computed(flag: bool) -> CommandResult {
    let arg = if flag { "-a" } else { "" };
    run_docker(&["ps", arg])
}
