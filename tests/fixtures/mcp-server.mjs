import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'branch-test-fixture',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}},
  {name:'not-allowed',inputSchema:{type:'object'}}
]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const text=request.params.arguments?.text;
  if(text==='failure')return {isError:true,content:[{type:'text',text:'internal secret'}]};
  return {content:[{type:'text',text:JSON.stringify({text,secret:process.env.BRANCH_TEST_SECRET,leaked:!!process.env.BRANCH_UNRELATED_SECRET})}]};
});
await server.connect(new StdioServerTransport());
