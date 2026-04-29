import { useMemo, useState } from "react";
import styles from "./EmailBodyDrawer.module.css";
import { Drawer } from "./Drawer";
import { EmailHtmlFrame } from "./EmailHtmlFrame";
import { EmailTextBody } from "./EmailTextBody";
import type { EmailBody } from "../lib/imap";

export const EMAIL_BODY_DRAWER_WIDTH = Math.min(
  560,
  Math.round(window.innerWidth * 0.6),
);

interface Props {
  body: EmailBody;
  /** True while the body content is still being fetched. The header
   *  (subject, from, date) renders immediately from the envelope; the
   *  body area shows a loading indicator until the fetch returns. */
  loading?: boolean;
  onClose: () => void;
}

// Cheap test for "this HTML body references remote images" — used only
// to decide whether the Show-images button is meaningful for this
// message. Conservative: a false positive just shows the button on a
// message where it does nothing, which is harmless.
const REMOTE_IMG_REGEX = /<img[^>]+src\s*=\s*["']?https?:/i;

export function EmailBodyDrawer({ body, loading = false, onClose }: Props) {
  const fromLabel = body.from
    .map((a) => a.name ?? `${a.mailbox ?? ""}@${a.host ?? ""}`)
    .filter((s) => s && s !== "@")
    .join(", ");
  const hasContent = body.textBody !== null || body.htmlBody !== null;

  const [showRemoteImages, setShowRemoteImages] = useState(false);

  const showImagesButtonVisible = useMemo(
    () => Boolean(body.htmlBody && REMOTE_IMG_REGEX.test(body.htmlBody)),
    [body.htmlBody],
  );

  return (
    <Drawer
      width={EMAIL_BODY_DRAWER_WIDTH}
      zIndex={30}
      onClose={onClose}
      header={
        <div className={styles.headerMeta}>
          <div className={styles.headerTitle}>
            {body.subject ?? "(no subject)"}
          </div>
          <div className={styles.headerMeta}>
            {fromLabel}
            {body.date && <> · {body.date}</>}
          </div>
        </div>
      }
    >
      {loading && !hasContent ? (
        <div className={styles.loadingState}>
          Loading message…
        </div>
      ) : body.htmlBody ? (
        <>
          {showImagesButtonVisible && !showRemoteImages && (
            <div className={styles.showImagesBanner}>
              <span className={styles.showImagesText}>
                Remote images blocked to protect privacy
              </span>
              <button
                type="button"
                onClick={() => setShowRemoteImages(true)}
                className={styles.showImagesButton}
              >
                Show images
              </button>
            </div>
          )}
          <div className={styles.htmlFrameWrapper}>
            <EmailHtmlFrame
              html={body.htmlBody}
              inlineParts={body.inlineParts}
              showRemoteImages={showRemoteImages}
            />
          </div>
        </>
      ) : body.textBody ? (
        <EmailTextBody text={body.textBody} />
      ) : (
        <div className={styles.noBody}>
          (no body)
        </div>
      )}
      {body.attachments.length > 0 && (
        <ul className={styles.attachmentsList}>
          {body.attachments.map((a, i) => (
            <li
              key={i}
              className={styles.attachmentItem}
            >
              {a.filename ?? "(unnamed)"} · {a.contentType} · {a.size} bytes
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
