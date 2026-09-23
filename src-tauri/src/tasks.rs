use serde::{Deserialize, Serialize};

/// One configured task from the global `tasks.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Deserialize)]
struct TasksFile {
    #[serde(default)]
    tasks: Vec<TaskSpec>,
}

/// Parse global `tasks.json` contents. A structurally wrong value (invalid
/// JSON, a non-object root, or a task missing `name` or `command`) surfaces as
/// a UI-readable error instead of crashing.
pub fn parse_tasks(text: &str) -> Result<Vec<TaskSpec>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "tasks.json 格式错误".to_string())?;
    // Reject non-object roots (e.g. an array) so only the documented shape works.
    if !value.is_object() {
        return Err("tasks.json 格式错误".to_string());
    }
    let file: TasksFile =
        serde_json::from_value(value).map_err(|_| "tasks.json 格式错误".to_string())?;
    Ok(file.tasks)
}

#[cfg(test)]
mod tests {
    use super::parse_tasks;

    #[test]
    fn parses_a_task_list() {
        let tasks =
            parse_tasks(r#"{"tasks":[{"name":"build","command":"cargo build"}]}"#).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].name, "build");
        assert_eq!(tasks[0].command, "cargo build");
    }

    #[test]
    fn tolerates_an_object_without_tasks() {
        assert!(parse_tasks("{}").unwrap().is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_tasks("{not json").unwrap_err();
        assert_eq!(err, "tasks.json 格式错误");
    }

    #[test]
    fn rejects_non_object_roots() {
        assert!(parse_tasks("[]").is_err());
        assert!(parse_tasks(r#""tasks""#).is_err());
    }

    #[test]
    fn rejects_a_task_missing_command_or_name() {
        assert!(parse_tasks(r#"{"tasks":[{"name":"only"}]}"#).is_err());
        assert!(parse_tasks(r#"{"tasks":[{"command":"echo hi"}]}"#).is_err());
    }
}