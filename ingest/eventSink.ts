import { Kafka, logLevel, type Producer } from 'kafkajs';

import type { EventstreamConfig } from './config.js';
import type { NormalizedTransitEvent } from './events.js';

const EVENTSTREAM_BATCH_TARGET_BYTES = 800_000;
const KAFKA_MESSAGE_OVERHEAD_BYTES = 64;

export interface KafkaEventMessage {
  key: string;
  value: string;
  headers: { eventType: string };
}

function messageSize(message: KafkaEventMessage) {
  return (
    Buffer.byteLength(message.key, 'utf8') +
    Buffer.byteLength(message.value, 'utf8') +
    Buffer.byteLength('eventType', 'utf8') +
    Buffer.byteLength(message.headers.eventType, 'utf8') +
    KAFKA_MESSAGE_OVERHEAD_BYTES
  );
}

export function batchTransitEvents(
  events: NormalizedTransitEvent[],
  maxBatchBytes = EVENTSTREAM_BATCH_TARGET_BYTES
) {
  const batches: KafkaEventMessage[][] = [];
  let batch: KafkaEventMessage[] = [];
  let batchBytes = 0;

  for (const event of events) {
    const message: KafkaEventMessage = {
      key: event.eventId,
      value: JSON.stringify(event),
      headers: { eventType: event.eventType },
    };
    const bytes = messageSize(message);
    if (bytes > maxBatchBytes) {
      throw new Error(
        `Transit event '${event.eventId}' is ${bytes} bytes and exceeds the ${maxBatchBytes}-byte publish limit.`
      );
    }
    if (batch.length > 0 && batchBytes + bytes > maxBatchBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(message);
    batchBytes += bytes;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export interface EventSink {
  publish(events: NormalizedTransitEvent[]): Promise<void>;
  close(): Promise<void>;
}

class NoopSink implements EventSink {
  async publish(): Promise<void> {}
  async close(): Promise<void> {}
}

class KafkaEventstreamSink implements EventSink {
  private readonly producer: Producer;
  private connected = false;

  constructor(private readonly config: EventstreamConfig) {
    const kafka = new Kafka({
      clientId: 'ttc-digital-twin-publisher',
      brokers: config.brokers,
      ssl: true,
      sasl: {
        mechanism: 'plain',
        username: config.username,
        password: config.password,
      },
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      logLevel: logLevel.WARN,
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: false });
  }

  async publish(events: NormalizedTransitEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    for (const messages of batchTransitEvents(events)) {
      await this.producer.send({
        topic: this.config.topic,
        acks: 1,
        messages,
      });
    }
  }

  async close(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
    this.connected = false;
  }
}

export function createEventSink(config: EventstreamConfig | null): EventSink {
  return config ? new KafkaEventstreamSink(config) : new NoopSink();
}