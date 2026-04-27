import { Fragment } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  text: string;
}

// Match bare http(s) URLs and mailto: addresses; conservative on
// trailing punctuation so a sentence like "see https://example.com."
// doesn't capture the period as part of the link.
const URL_REGEX = /\b(?:https?:\/\/|mailto:)[^\s<>"']+[^\s<>"'.,;:!?)]/gi;

/** Renders an email's plain-text body with whitespace preserved and
 *  bare URLs auto-linkified through `@tauri-apps/plugin-opener` so
 *  clicks open the system browser instead of trying to navigate the
 *  Tauri app shell. */
export function EmailTextBody({ text }: Props) {
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: 0,
        padding: "12px 18px",
        fontFamily: "inherit",
        fontSize: 13,
        lineHeight: 1.5,
        color: "rgba(255, 255, 255, 0.9)",
      }}
    >
      {linkify(text)}
    </pre>
  );
}

function linkify(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  let key = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(
        <Fragment key={`t${key++}`}>
          {text.slice(lastIndex, match.index)}
        </Fragment>,
      );
    }
    const url = match[0];
    out.push(
      <a
        key={`a${key++}`}
        href={url}
        onClick={(event) => {
          event.preventDefault();
          void openUrl(url);
        }}
        style={{ color: "#7ab7ff" }}
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) {
    out.push(<Fragment key={`t${key++}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return out;
}
