import React from "react";
import ReactMarkdown from "react-markdown";
import { TextContentBlock } from "@bytebot/shared";

interface TextContentProps {
  block: TextContentBlock;
}

export function TextContent({ block }: TextContentProps) {
  return (
    <div className="mb-3">
      <div className="text-bytebot-bronze-dark-8 prose prose-sm max-w-none text-sm">
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h1 className="text-bytebot-bronze-dark-9 mt-4 mb-2 text-base font-semibold">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-bytebot-bronze-dark-9 mt-3 mb-2 text-sm font-semibold">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-bytebot-bronze-dark-9 mt-3 mb-1 text-sm font-medium">
                {children}
              </h3>
            ),
            h4: ({ children }) => (
              <h4 className="text-bytebot-bronze-dark-8 mt-2 mb-1 text-sm font-medium">
                {children}
              </h4>
            ),
            h5: ({ children }) => (
              <h5 className="text-bytebot-bronze-dark-8 mt-2 mb-1 text-xs font-medium">
                {children}
              </h5>
            ),
            h6: ({ children }) => (
              <h6 className="text-bytebot-bronze-dark-8 mt-2 mb-1 text-xs font-medium">
                {children}
              </h6>
            ),
            p: ({ children }) => (
              <p className="mb-2 leading-relaxed">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="mb-2 ml-4 list-disc">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="mb-2 ml-4 list-decimal">
                {children}
              </ol>
            ),
            li: ({ children }) => (
              <li className="mb-1 text-sm leading-relaxed">
                {children}
              </li>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-bytebot-bronze-light-7 text-bytebot-bronze-dark-7 mb-2 border-l-4 pl-4 italic">
                {children}
              </blockquote>
            ),
            code: ({ children, className }) => {
              const isInline = !className;
              return isInline ? (
                <code className="text-bytebot-bronze-dark-9 rounded px-1 py-0.5 font-mono text-xs">
                  {children}
                </code>
              ) : (
                <code className="text-bytebot-bronze-dark-9 block overflow-x-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => (
              <pre className="mb-2 overflow-x-auto rounded border p-3">
                {children}
              </pre>
            ),
            strong: ({ children }) => (
              <strong className="text-bytebot-bronze-dark-9 font-semibold">
                {children}
              </strong>
            ),
            em: ({ children }) => (
              <em className="text-bytebot-bronze-dark-8 italic">
                {children}
              </em>
            ),
            a: ({ children, href }) => (
              <a
                href={href}
                className="text-blue-600 underline hover:text-blue-800"
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ),
          }}
        >
          {block.text}
        </ReactMarkdown>
      </div>
    </div>
  );
}