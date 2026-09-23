use std::fmt::Display;

pub fn io_error(action: &str, err: impl Display) -> String {
    format!("Failed to {action}: {err}")
}