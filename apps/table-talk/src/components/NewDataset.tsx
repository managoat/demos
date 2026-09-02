/**
 * The empty desk: one big dropzone ("Drop a CSV, or paste one"), then a local
 * preview — parsed in this browser, nothing sent — and the Analyze button
 * that hands the data to the analyst.
 */
import { useRef, useState, type DragEvent } from "react";
import { prepareDataset, type Dataset } from "../lib/csv";
import { fmtNum } from "../lib/format";

const PREVIEW_ROWS = 50;

export function NewDataset(props: { busy: boolean; status: string | null; onAnalyze: (d: Dataset) => void }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = (filename: string, text: string) => {
    try {
      setDataset(prepareDataset(filename, text));
      setError(null);
      setPasting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then(
      (text) => load(file.name, text),
      () => setError("Couldn't read that file."),
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    onFile(e.dataTransfer.files[0]);
  };

  if (dataset) {
    const shown = dataset.rows.slice(0, PREVIEW_ROWS);
    return (
      <div className="newdata">
        <div className="preview-head">
          <div>
            <h2>{dataset.filename}</h2>
            <p className="fineprint">
              {fmtNum(dataset.rows.length)} rows · {fmtNum(dataset.headers.length)} columns
              {shown.length < dataset.rows.length ? ` · previewing the first ${PREVIEW_ROWS}` : ""}
            </p>
            {dataset.notice && <p className="notice">{dataset.notice}</p>}
          </div>
          <div className="preview-actions">
            <button onClick={() => setDataset(null)} disabled={props.busy}>
              Different file
            </button>
            <button className="primary" onClick={() => props.onAnalyze(dataset)} disabled={props.busy}>
              {props.busy ? "Analyzing…" : "Analyze"}
            </button>
          </div>
        </div>
        {props.status && <p className="status">{props.status}</p>}
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                {dataset.headers.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, ri) => (
                <tr key={ri}>
                  {dataset.headers.map((_h, ci) => (
                    <td key={ci}>{row[ci] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="newdata center">
      <div
        className={dragOver ? "dropzone over" : "dropzone"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
      >
        <div className="dropzone-icon" aria-hidden>
          📊
        </div>
        <p className="dropzone-line">Drop a CSV here</p>
        <p className="fineprint">or click to choose a file — up to 400 KB / 5,000 rows</p>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="error center-text">{error}</p>}
      {pasting ? (
        <div className="paste-area">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"region,revenue\nwest,120\neast,80"}
            rows={8}
            autoFocus
          />
          <div className="preview-actions">
            <button onClick={() => setPasting(false)}>Never mind</button>
            <button className="primary" onClick={() => load("pasted.csv", pasted)} disabled={!pasted.trim()}>
              Use this
            </button>
          </div>
        </div>
      ) : (
        <button className="linkish" onClick={() => setPasting(true)}>
          paste a CSV instead
        </button>
      )}
    </div>
  );
}
