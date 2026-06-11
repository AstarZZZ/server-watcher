import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Cable, Lock, RotateCcw, TerminalSquare, Unplug } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

interface TerminalPaneProps {
  username: string;
  theme: "dark" | "light";
}

function terminalTheme(theme: "dark" | "light") {
  if (theme === "light") {
    return {
      background: "#f8fafc",
      foreground: "#172033",
      cursor: "#0891b2",
      selectionBackground: "#bfdbfe"
    };
  }
  return {
    background: "#05070b",
    foreground: "#d8dee9",
    cursor: "#7dd3fc",
    selectionBackground: "#1f3347"
  };
}

export default function TerminalPane({ username, theme }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("未连接");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      terminalRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme(theme);
    }
  }, [theme]);

  function ensureTerminal() {
    if (!containerRef.current) return null;
    if (terminalRef.current) return terminalRef.current;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      theme: terminalTheme(theme)
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });
    window.addEventListener("resize", () => fit.fit());
    return terminal;
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    if (connected || connecting) return;
    const terminal = ensureTerminal();
    if (!terminal) return;
    socketRef.current?.close();
    terminal.clear();
    terminal.writeln(`Connecting ${username}@localhost ...`);
    const socket = new WebSocket(wsUrl("/ws/terminal"));
    const authPassword = password;
    let failed = false;
    socketRef.current = socket;
    setStatus("连接中");
    setConnecting(true);
    setConnected(false);

    socket.onopen = () => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      socket.send(JSON.stringify({ type: "auth", password: authPassword, cols, rows }));
    };

    socket.onmessage = (message) => {
      const payload = JSON.parse(message.data) as {
        type: string;
        data?: string;
        message?: string;
      };
      if (payload.type === "data" && payload.data) {
        setConnected(true);
        setConnecting(false);
        terminal.write(payload.data);
        return;
      }
      if (payload.type === "status") {
        setStatus(payload.message ?? "状态更新");
        if (payload.message?.includes("SSH 连接成功")) {
          setConnected(true);
          setConnecting(false);
          setPassword("");
        }
        terminal.writeln(`\r\n[server-watcher] ${payload.message ?? ""}`);
        return;
      }
      if (payload.type === "error") {
        failed = true;
        setConnected(false);
        setConnecting(false);
        setPassword("");
        setStatus(payload.message ?? "连接失败");
        terminal.writeln(`\r\n[error] ${payload.message ?? ""}`);
        socket.close();
      }
    };

    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      setConnecting(false);
      setConnected(false);
      if (!failed) setStatus("已断开");
    };

    socket.onerror = () => {
      failed = true;
      setConnecting(false);
      setConnected(false);
      setStatus("连接错误");
    };
  }

  function disconnect() {
    socketRef.current?.close();
    socketRef.current = null;
    setConnecting(false);
    setConnected(false);
    setStatus("已断开");
  }

  function resizeTerminal() {
    fitRef.current?.fit();
    const terminal = terminalRef.current;
    if (!terminal || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })
    );
  }

  const busy = connected || connecting;

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
            disabled={busy}
          />
        </label>
        <button className="primary-button" disabled={!password || busy}>
          <Cable size={16} />
          {connecting ? "连接中" : "连接终端"}
        </button>
        {busy && (
          <button type="button" className="secondary-button" onClick={disconnect}>
            <Unplug size={16} />
            断开
          </button>
        )}
        <span className={connected ? "status-chip live" : "status-chip"}>
          <TerminalSquare size={14} />
          {status}
        </span>
      </form>

      <div className="terminal-frame" ref={containerRef} />
    </section>
  );
}
