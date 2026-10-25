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

it.each(['true', 'false'])('preserves typed payload conversion for boolean %s and server validation errors', async value=>{
  vi.spyOn(pluginBindingsApi,'list').mockResolvedValue({bindings:[],diagnostics:[],packages:[{name:'sample',scope:'global',apiVersion:1,requiredSkills:[],legacyGlobal:[],configSchema:{count:{type:'integer',description:'Count'},ratio:{type:'number',description:'Ratio'},active:{type:'boolean',description:'Active'},names:{type:'string_list',description:'Names'},note:{type:'string',description:'Note'},token:{type:'secret',description:'Token'}}}]});
  const save=vi.spyOn(pluginBindingsApi,'save').mockRejectedValue(new Error('Invalid configuration count'));
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><PluginBindingsPanel/></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('插件'),{target:{value:'sample'}});
  fireEvent.change(screen.getByLabelText('Bot App ID'),{target:{value:'bot'}});
  fireEvent.change(screen.getByLabelText('count'),{target:{value:'invalid'}});
  fireEvent.change(screen.getByLabelText('ratio'),{target:{value:'2.5'}});
  fireEvent.change(screen.getByLabelText('active'),{target:{value}});
  fireEvent.change(screen.getByLabelText('names'),{target:{value:' alpha, , beta , alpha,'}});
  fireEvent.change(screen.getByLabelText('note'),{target:{value:'text'}});
  fireEvent.change(screen.getByLabelText('token'),{target:{value:'plugin.sample.token'}});
  fireEvent.click(screen.getByRole('button',{name:'保存绑定'}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({config:{count:NaN,ratio:2.5,active:value==='true',names:['alpha','beta','alpha'],note:'text'},secrets:{token:'plugin.sample.token'}})));
  expect(await screen.findByText('Invalid configuration count')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('count'),{target:{value:'4'}});
  expect(screen.getByText('Invalid configuration count')).toBeTruthy();
  expect(screen.getByRole('button',{name:'保存绑定'}).hasAttribute('disabled')).toBe(false);
});

it('deletes cleared non-string values and secret references while saving an empty string', async()=>{
  vi.spyOn(pluginBindingsApi,'list').mockResolvedValue({bindings:[{id:'binding',plugin:'sample',botAppId:'bot',enabled:true,revision:2,skills:[],config:{count:3,ratio:2.5,active:true,names:['alpha'],note:'text'},secrets:{token:'plugin.sample.token'}}],diagnostics:[],packages:[{name:'sample',scope:'global',apiVersion:1,requiredSkills:[],legacyGlobal:[],configSchema:{count:{type:'integer',description:'Count'},ratio:{type:'number',description:'Ratio'},active:{type:'boolean',description:'Active'},names:{type:'string_list',description:'Names'},note:{type:'string',description:'Note'},token:{type:'secret',description:'Token'}}}]});
  const save=vi.spyOn(pluginBindingsApi,'save').mockImplementation(async input=>({binding:{...input,id:'binding',revision:3}}));
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><PluginBindingsPanel/></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'sample · bot · r2'}));
  for(const name of ['count','ratio','active','names','note','token']) fireEvent.change(screen.getByLabelText(name),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:'保存绑定'}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({config:{note:''},secrets:{},expectedRevision:2})));
});

it('renders declarative Web slot elements as a bounded preview', async()=>{
  vi.spyOn(pluginBindingsApi,'list').mockResolvedValue({bindings:[],diagnostics:[],packages:[{name:'sample',scope:'global',apiVersion:1,requiredSkills:[],legacyGlobal:[],configSchema:{},slots:[{id:'overview',slot:'task_panel',title:'任务概览',description:'插件提供的只读信息',elements:[{kind:'text',label:'说明',text:'已连接'},{kind:'status',label:'状态',tone:'accent',value:'正常'},{kind:'table',columns:['键','值'],rows:[['版本','1.0']]},{kind:'action',label:'打开详情',target:{kind:'command',command:'details'}}]}]}]});
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><PluginBindingsPanel/></QueryClientProvider>);
  expect(await screen.findByText('任务概览')).toBeTruthy();
  expect(screen.getByText('已连接')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('正常');
  expect(screen.getByRole('columnheader',{name:'键'})).toBeTruthy();
  const action=screen.getByRole('button',{name:'打开详情'});
  expect(action.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/命令：details · 受限预览/)).toBeTruthy();
});
