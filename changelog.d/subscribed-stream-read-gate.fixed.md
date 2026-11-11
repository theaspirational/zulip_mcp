- Subscribed-stream mode now authorizes immutable stream IDs across message,
  topic, poll, stream-list, context, attachment and monitoring reads, including
  after the last asynchronous operation. Renames and reused names cannot grant
  access to a different public stream. Attachment fetches in this mode require
  a readable source `message_id`; the default mode is unchanged.
