import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginBindingsPanel } from './PluginBindingsPanel';
import { pluginBindingsApi } from '../api';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('edits typed settings and secret references in the same binding payload exposed by settings CLI', async()=>{
  vi.spyOn(pluginBindingsApi,'list').mockResolvedValue({bindings:[],diagnostics:[],packages:[{name:'sample',scope:'global',apiVersion:1,requiredSkills:['sample/answer'],legacyGlobal:[],configSchema:{count:{type:'integer',description:'Count',default:2},token:{type:'secret',description:'Token',required:true},mode:{type:'string',description:'Mode',enum:['brief','full']}}}]});
  const save=vi.spyOn(pluginBindingsApi,'save').mockImplementation(async input=>({binding:{...input,id:'binding',revision:1}}));
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><PluginBindingsPanel/></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('插件'),{target:{value:'sample'}});
  fireEvent.change(screen.getByLabelText('绑定目标'),{target:{value:'group'}});
  fireEvent.change(screen.getByLabelText('Bot App ID'),{target:{value:'bot'}});fireEvent.change(screen.getByLabelText('群 ID'),{target:{value:'group'}});
  fireEvent.change(screen.getByLabelText('count'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('mode'),{target:{value:'brief'}});
  fireEvent.change(screen.getByLabelText('token'),{target:{value:'plugin.sample.group-a'}});
  fireEvent.click(screen.getByRole('button',{name:'保存绑定'}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({plugin:'sample',botAppId:'bot',chatId:'group',config:{count:3,mode:'brief'},secrets:{token:'plugin.sample.group-a'},expectedRevision:0})));
});
