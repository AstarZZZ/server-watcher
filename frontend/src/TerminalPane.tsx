import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Cable, Lock, RotateCcw, TerminalSquare } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

interface TerminalPaneProps {
  username: string;
}

export default function TerminalPane({ username }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("未连接");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      terminalRef.current?.dispose();
    };
  }, []);

  function ensureTerminal() {
    if (!containerRef.current) return null;
    if (terminalRef.current) return terminalRef.current;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      theme: {
        background: "#05070b",
        foreground: "#d8dee9",
        cursor: "#7dd3fc",
        selectionBackground: "#1f3347"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.onData((data) => {
      socketRef.current?.send(JSON.stringify({ type: "input", data }));
    });
    window.addEventListener("resize", () => fit.fit());
    return terminal;
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    const terminal = ensureTerminal();
    if (!terminal) return;
    terminal.clear();
    terminal.writeln(`Connecting ${username}@localhost ...`);
    const socket = new WebSocket(wsUrl("/ws/terminal"));
    socketRef.current = socket;
    setStatus("连接中");

    socket.onopen = () => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      socket.send(JSON.stringify({ type: "auth", password, cols, rows }));
      setPassword("");
    };

    socket.onmessage = (message) => {
      const payload = JSON.parse(message.data) as {
        type: string;
        data?: string;
        message?: string;
      };
      if (payload.type === "data" && payload.data) {
        terminal.write(payload.data);
        return;
      }
      if (payload.type === "status") {
        setStatus(payload.message ?? "状态更新");
        terminal.writeln(`\r\n[server-watcher] ${payload.message ?? ""}`);
        return;
      }
      if (payload.type === "error") {
        setStatus(payload.message ?? "连接失败");
        terminal.writeln(`\r\n[error] ${payload.message ?? ""}`);
      }
    };

    socket.onclose = () => {
      setConnected(false);
      setStatus("已断开");
    };

    socket.onerror = () => {
      setStatus("连接错误");
    };

    setConnected(true);
  }

  function resizeTerminal() {
    fitRef.current?.fit();
    const terminal = terminalRef.current;
    if (!terminal || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })
    );
  }

  return (
    <section className="terminal-page">
      <div className="section-head">
        <div>
          <h2>Web SSH 终端</h2>
          <p>当前会话账号：{username}。密码只用于本次 SSH 连接，不会保存。</p>
        </div>
        <button className="icon-button" onClick={resizeTerminal} title="重置终端尺寸">
          <RotateCcw size={17} />
        </button>
      </div>

      <form className="terminal-login" onSubmit={connect}>
        <label>
          <Lock size={16} />
          <input
            type="password"
            placeholder="SSH 密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={connected}
          />
        </label>
        <button className="primary-button" disabled={!password || connected}>
          <Cable size={16} />
          连接终端
        </button>
        <span className={connected ? "status-chip live" : "status-chip"}>
          <TerminalSquare size={14} />
          {status}
        </span>
      </form>

      <div className="terminal-frame" ref={containerRef} />
    </section>
  );
}
