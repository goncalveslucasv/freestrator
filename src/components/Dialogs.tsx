"use client";

import { useState } from "react";
import { setBridgeEnabled } from "@/lib/bridge";
import { vectorizeImage, type VectorizeChoice } from "@/lib/actions";
import { useEditor } from "@/lib/store";

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card dialog" role="dialog" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="btn icon" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const DETAILS: { value: VectorizeChoice["detail"]; label: string; hint: string }[] = [
  { value: "low", label: "Simple", hint: "Logos e íconos: pocos colores, formas limpias" },
  { value: "medium", label: "Normal", hint: "Ilustraciones e infografías" },
  { value: "high", label: "Detallado", hint: "Mucho detalle y colores; más formas" },
];

export function VectorizeDialog({ onClose }: { onClose: () => void }) {
  const [choice, setChoice] = useState<VectorizeChoice>({ detail: "medium", ocr: false, skipBackground: false });
  return (
    <Dialog title="Vectorizar imagen" onClose={onClose}>
      <p className="muted small">
        Convierte la imagen seleccionada (o la foto de referencia) en formas editables. Detecta rectángulos, círculos y rectángulos redondeados, y el resultado
        es siempre el mismo para la misma imagen.
      </p>
      <fieldset className="dialog-group">
        <legend>Detalle</legend>
        {DETAILS.map((d) => (
          <label key={d.value} className="dialog-option">
            <input type="radio" name="detail" checked={choice.detail === d.value} onChange={() => setChoice({ ...choice, detail: d.value })} />
            <span>
              {d.label} <span className="muted small">— {d.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="dialog-option">
        <input type="checkbox" checked={choice.ocr} onChange={(e) => setChoice({ ...choice, ocr: e.target.checked })} />
        <span>
          Detectar texto (OCR) <span className="muted small">— crea texto editable; la primera vez descarga ~10 MB</span>
        </span>
      </label>
      <label className="dialog-option">
        <input type="checkbox" checked={choice.skipBackground} onChange={(e) => setChoice({ ...choice, skipBackground: e.target.checked })} />
        <span>
          Quitar el fondo <span className="muted small">— omite el color que rodea la imagen</span>
        </span>
      </label>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="btn primary"
          onClick={() => {
            onClose();
            vectorizeImage(choice);
          }}
        >
          Vectorizar
        </button>
      </div>
    </Dialog>
  );
}

const CLAUDE_CODE = "claude mcp add freestrator -- npx -y freestrator-mcp";
const CLAUDE_DESKTOP = `{
  "mcpServers": {
    "freestrator": {
      "command": "npx",
      "args": ["-y", "freestrator-mcp"]
    }
  }
}`;

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyable">
      <pre>{text}</pre>
      <button
        className="btn mini"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const bridge = useEditor((s) => s.bridge);
  return (
    <Dialog title="Conectar con Claude" onClose={onClose}>
      <p className="muted small">
        Claude usa Freestrator a través de un servidor MCP que corre en tu computadora. Lo que Claude dibuja aparece acá en vivo y lo que editás acá lo ve
        Claude. Tus archivos no pasan por ningún servidor.
      </p>
      <ol className="dialog-steps">
        <li>
          Instalá el servidor (necesita Node.js 20 o superior).
          <div className="muted small">Claude Code:</div>
          <Copyable text={CLAUDE_CODE} />
          <div className="muted small">Claude Desktop, en Configuración › Desarrollador › Editar configuración:</div>
          <Copyable text={CLAUDE_DESKTOP} />
        </li>
        <li>Reiniciá Claude para que cargue el servidor.</li>
        <li>
          Activá la conexión. El navegador te va a pedir permiso para acceder a <b>apps de este dispositivo</b> (red local): aceptalo, es la conexión con el
          servidor en tu computadora.
        </li>
      </ol>
      <div className="dialog-actions">
        <span className={`bridge-status ${bridge}`}>
          {bridge === "on" ? "● Claude conectado" : bridge === "connecting" ? "○ Esperando a Claude…" : "Desconectado"}
        </span>
        {bridge === "off" ? (
          <button className="btn primary" onClick={() => setBridgeEnabled(true)}>
            Conectar
          </button>
        ) : (
          <button className="btn" onClick={() => setBridgeEnabled(false)}>
            Desconectar
          </button>
        )}
      </div>
    </Dialog>
  );
}
