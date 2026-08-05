import { describe,expect,it,vi } from 'vitest';
import { ConversationResolverService } from '../conversation-resolver';
describe('ConversationResolverService',()=>{
 it('uses only connection and customer identity',async()=>{const conversation={id:'v1',workspace_id:'derived',connection_id:'cc1',customer_id:'c1',channel:'telegram' as const,status:'new'};const client={query:vi.fn().mockResolvedValue({rows:[conversation]})};await expect(ConversationResolverService.resolve('cc1','c1',client)).resolves.toEqual(conversation);expect(client.query).toHaveBeenCalledWith('SELECT * FROM resolve_active_conversation($1,$2)',['cc1','c1']);});
 it('rejects missing identity without querying',async()=>{const client={query:vi.fn()};await expect(ConversationResolverService.resolve('','c1',client)).rejects.toThrow('connectionId and customerId are required');expect(client.query).not.toHaveBeenCalled();});
 it.each(['42501','28000','23503'])('propagates database error %s',async code=>{const error=Object.assign(new Error('database rejected resolver'),{code});const client={query:vi.fn().mockRejectedValue(error)};await expect(ConversationResolverService.resolve('cc1','c1',client)).rejects.toBe(error);});
 it('rejects an unexpected empty database result',async()=>{const client={query:vi.fn().mockResolvedValue({rows:[]})};await expect(ConversationResolverService.resolve('cc1','c1',client)).rejects.toThrow('conversation resolver returned no conversation');});
});
