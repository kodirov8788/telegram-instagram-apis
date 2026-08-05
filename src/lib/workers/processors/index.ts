import { DatabaseSecretProvider } from '../../services/secret-provider';
import { workerRecordTransaction } from '../transaction';
import { processInboundEvent as processInbound } from './inbound';
import { processOutboundJob as processOutbound } from './outbound';

export const processInboundEvent = processInbound;

export const processOutboundJob = (id: string) => {
  const transaction = workerRecordTransaction('outbound_jobs', id);
  return processOutbound(id, new DatabaseSecretProvider(transaction), { transaction });
};
