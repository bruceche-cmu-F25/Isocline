import type { ReactNode } from "react";
import { linkParts } from "./links.ts";
import "./links.css";

/** A link that leads outside Isocline, drawn so it reads as one. It opens in a new tab; in the Mac app, in the
 * user's browser. A click on it is not also a click on the row or card it stands in. */
export function OutLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a className={className ? `${className} text-link` : "text-link"} href={href} target="_blank" rel="noreferrer noopener" onClick={(event) => event.stopPropagation()}>
      {children}
    </a>
  );
}

/** Text as it was written, with the web addresses in it as links. */
export function Linked({ text }: { text: string }) {
  return <>{linkParts(text).map((part, index) => (typeof part === "string" ? part : <OutLink key={index} href={part.url}>{part.text}</OutLink>))}</>;
}
