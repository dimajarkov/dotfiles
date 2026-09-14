export interface HerdrBlockedEvent {
  active: boolean;
  label?: string;
}

export async function withHerdrBlocked<T>(
  emit: (event: HerdrBlockedEvent) => void,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  emit({ active: true, label });
  try {
    return await operation();
  } finally {
    emit({ active: false });
  }
}
