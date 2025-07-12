import React from "react";
import { Role } from "@/types";
import { GroupedMessages } from "@/types";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";

interface MessageGroupProps {
  group: GroupedMessages;
}

export function MessageGroup({ group }: MessageGroupProps) {
  if (group.role === Role.ASSISTANT) {
    return <AssistantMessage group={group} />;
  }

  return <UserMessage group={group} />;
}