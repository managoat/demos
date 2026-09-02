import { useState } from "react";
import { relTime } from "../lib/format";
import { hashFor } from "../router";
import { useSession } from "../store";
import { Avatar } from "./Avatar";
import { Popover } from "./Menu";

export function Notifications() {
  const { notifications, readNotification } = useSession();
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="pill-wrap notification-wrap">
      <button className={`icon notification-button${open ? " on" : ""}`} aria-label={unread ? `${unread} unread notifications` : "Notifications"} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">♢</span>{unread > 0 && <span className="notification-count">{unread > 9 ? "9+" : unread}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="left" className="notification-pop">
        <div className="notification-head"><strong>Notifications</strong>{unread > 0 && <span className="muted tiny">{unread} new</span>}</div>
        {notifications.length === 0 && <div className="muted small pad">You’re all caught up.</div>}
        {notifications.map((n) => (
          <a
            key={n.id}
            href={hashFor({ page: "chat", id: n.chatId })}
            className={`notification-item${n.readAt ? "" : " unread"}`}
            onClick={() => { void readNotification(n.id); setOpen(false); }}
          >
            <Avatar email={n.actorEmail} size={26} />
            <span><strong>{n.actorEmail}</strong> mentioned you in <em>{n.chatTitle}</em><small>{relTime(n.createdAt)}</small></span>
          </a>
        ))}
      </Popover>
    </div>
  );
}
