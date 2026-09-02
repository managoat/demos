/** One conversation, filling the main area; the sidebar keeps the rest of the project in reach. */
import { useProject } from "../store";
import { itemIdOf } from "../lib/sidebar";
import { href, navigate } from "../router";
import { Thread } from "../components/Thread";

export function Conversation({ conversationId, turnId }: { conversationId: string; turnId?: string | null }) {
  const { project, items, conversations } = useProject();
  const listed = conversations.find((c) => c.id === conversationId) ?? null;
  const itemId = listed ? itemIdOf(listed) : null;
  const item = itemId ? items.find((w) => w.id === itemId) ?? null : null;
  return (
    <div className="conversation-page">
      <Thread
        key={conversationId}
        conversationId={conversationId}
        focusTurnId={turnId ?? null}
        onClose={() => navigate(item ? href.item(project.id, item.id) : href.project(project.id))}
        context={item ? <a href={href.item(project.id, item.id)}>{item.title}</a> : null}
      />
    </div>
  );
}
