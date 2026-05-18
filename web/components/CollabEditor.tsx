"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import type { editor } from "monaco-editor";
import { useYjsDoc } from "@/lib/useYjsDoc";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Props = {
  roomId: number;
  docId: string;
  userName: string;
  language?: string;
  height?: string;
  readOnly?: boolean;
};

export default function CollabEditor({
  roomId,
  docId,
  userName,
  language = "plaintext",
  height = "100%",
  readOnly = false,
}: Props) {
  const { doc, provider, synced } = useYjsDoc(roomId, docId, userName);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);

  useEffect(() => {
    return () => {
      bindingRef.current?.destroy();
      bindingRef.current = null;
    };
  }, [roomId, docId]);

  return (
    <div className="relative h-full w-full">
      {!synced && (
        <div className="absolute top-2 right-3 z-10 text-xs px-2 py-1 rounded bg-panel border border-border text-muted">
          Connexion…
        </div>
      )}
      <Editor
        height={height}
        theme="vs-dark"
        defaultLanguage={language}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          readOnly,
          automaticLayout: true,
        }}
        onMount={(ed) => {
          editorRef.current = ed;
          if (doc && provider) {
            const yText = doc.getText("monaco");
            bindingRef.current = new MonacoBinding(
              yText,
              ed.getModel()!,
              new Set([ed]),
              provider.awareness,
            );
          }
        }}
      />
    </div>
  );
}
