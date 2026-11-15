// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let value_of = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned());
    if let Some(dir) = value_of("--pov-serve") {
        let identity = value_of("--identity").unwrap_or_else(|| "pov-test-identity.key".into());
        std::process::exit(rewatch_lib::cli_pov_serve(dir, identity, value_of("--allow").unwrap_or_default(), value_of("--watch")));
    }
    if args.iter().any(|a| a == "--pov-code") {
        std::process::exit(rewatch_lib::cli_pov_code(value_of("--identity").unwrap_or_else(|| "pov-test-identity.key".into())));
    }
    if let Some(code) = value_of("--pov-fetch") {
        let identity = value_of("--identity").unwrap_or_else(|| "pov-test-identity.key".into());
        std::process::exit(rewatch_lib::cli_pov_fetch(code, identity, value_of("--game-dir").unwrap_or_default()));
    }
    if let Some(code) = value_of("--pov-ping") {
        let identity = value_of("--identity").unwrap_or_else(|| "pov-test-identity.key".into());
        std::process::exit(rewatch_lib::cli_pov_ping(code, identity));
    }
    if let Some(code) = value_of("--pov-extras") {
        let identity = value_of("--identity").unwrap_or_else(|| "pov-test-identity.key".into());
        std::process::exit(rewatch_lib::cli_pov_extras(code, identity, value_of("--game-dir").unwrap_or_default()));
    }
    if args.iter().any(|a| a == "--update-check") {
        std::process::exit(rewatch_lib::cli_update_check(args.iter().any(|a| a == "--download")));
    }
    if let Some(dir) = value_of("--make-copy") {
        std::process::exit(rewatch_lib::cli_make_copy(dir));
    }
    if let Some(dir) = value_of("--voice") {
        std::process::exit(rewatch_lib::cli_voice(dir));
    }
    if let Some(i) = args.iter().position(|a| a == "--split-clip") {
        let arg = |n: usize| args.get(i + n).cloned().unwrap_or_default();
        let num = |n: usize| arg(n).parse::<f64>().unwrap_or(0.0);
        std::process::exit(rewatch_lib::cli_split_clip(arg(1), arg(2), num(3), num(4), arg(5), num(6)));
    }
    if let Some(dir) = value_of("--highlights") {
        std::process::exit(rewatch_lib::cli_highlights(dir, args.iter().any(|a| a == "--save")));
    }
    if let Some(i) = args.iter().position(|a| a == "--team") {
        let arg = |n: usize| args.get(i + n).cloned().unwrap_or_default();
        let view = args.iter().position(|a| a == "--view").map(|j| {
            let at = |n: usize| args.get(j + n).cloned().unwrap_or_default();
            (at(1), at(2).parse::<f64>().unwrap_or(0.0), at(3))
        });
        std::process::exit(rewatch_lib::cli_team(arg(1), arg(2).parse().unwrap_or(0.0), arg(3).parse().unwrap_or(0.0), value_of("--key-file").unwrap_or_default(), view));
    }
    if let Some(dir) = value_of("--coach") {
        std::process::exit(rewatch_lib::cli_coach(dir, value_of("--key-file").unwrap_or_default()));
    }
    if let Some(dir) = value_of("--postgame") {
        std::process::exit(rewatch_lib::cli_postgame(dir, value_of("--key-file")));
    }
    if args.iter().any(|a| a == "--riot-probe") {
        std::process::exit(rewatch_lib::cli_riot_probe());
    }
    if let Some(dir) = value_of("--titles") {
        std::process::exit(rewatch_lib::cli_titles(dir));
    }
    if let Some(dir) = value_of("--insights") {
        std::process::exit(rewatch_lib::cli_insights(dir, value_of("--key-file").unwrap_or_default()));
    }
    if args.iter().any(|a| a == "--test-notify") {
        std::process::exit(rewatch_lib::cli_test_notify());
    }
    if args.iter().any(|a| a == "--list-mics") {
        std::process::exit(rewatch_lib::cli_list_mics());
    }
    if let Some(i) = args.iter().position(|a| a == "--test-record") {
        let secs = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(10);
        let out = args
            .iter()
            .position(|a| a == "--out")
            .and_then(|j| args.get(j + 1).cloned());
        let encoder = args
            .iter()
            .position(|a| a == "--encoder")
            .and_then(|j| args.get(j + 1).cloned());
        let hotkey = args
            .iter()
            .position(|a| a == "--hotkey")
            .and_then(|j| args.get(j + 1).cloned());
        std::process::exit(rewatch_lib::cli_test_record(secs, out, encoder, hotkey, value_of("--codec")));
    }
    rewatch_lib::run()
}
