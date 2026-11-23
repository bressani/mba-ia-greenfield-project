const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

interface MailpitAddress {
  Address: string;
}

interface MailpitMessage {
  ID: string;
  To: MailpitAddress[];
  From: MailpitAddress;
  Subject: string;
}

function isMailpitAddress(value: unknown): value is MailpitAddress {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Address' in value &&
    typeof value.Address === 'string'
  );
}

function isMailpitMessage(value: unknown): value is MailpitMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ID' in value &&
    typeof value.ID === 'string' &&
    'To' in value &&
    Array.isArray(value.To) &&
    value.To.every(isMailpitAddress) &&
    'From' in value &&
    isMailpitAddress(value.From) &&
    'Subject' in value &&
    typeof value.Subject === 'string'
  );
}

export async function getMailpitMessages(): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data: unknown = await res.json();
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid Mailpit message list');
  }
  if (!('messages' in data) || data.messages == null) {
    return [];
  }
  if (!Array.isArray(data.messages) || !data.messages.every(isMailpitMessage)) {
    throw new Error('Invalid messages in Mailpit message list');
  }
  return data.messages;
}

export async function getMailpitMessage(id: string): Promise<{ HTML: string }> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  const data: unknown = await res.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !('HTML' in data) ||
    typeof data.HTML !== 'string'
  ) {
    throw new Error('Invalid Mailpit message HTML');
  }
  return { HTML: data.HTML };
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
