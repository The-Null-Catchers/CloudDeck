import 'package:flutter/material.dart';
import '../app_state.dart';
import '../models.dart';
import 'server_detail_screen.dart';

final class ServersScreen extends StatelessWidget{
  const ServersScreen({super.key,required this.state});
  final AppState state;
  @override Widget build(BuildContext context)=>RefreshIndicator(
    onRefresh:state.refreshOverview,
    child:ListView(
      padding:const EdgeInsets.fromLTRB(16,12,16,120),
      children:[
        Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[
          Text('Servers',style:Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight:FontWeight.w800)),
          Text('${state.servers.length} total',style:Theme.of(context).textTheme.labelLarge),
        ]),
        const SizedBox(height:14),
        if(state.servers.isEmpty)const Card(child:Padding(padding:EdgeInsets.all(20),child:Text('No servers in this workspace.')))
        else ...state.servers.map((server)=>_ServerCard(state:state,server:server)),
      ],
    ),
  );
}

final class _ServerCard extends StatelessWidget{
  const _ServerCard({required this.state,required this.server});
  final AppState state;final ServerSummary server;
  @override Widget build(BuildContext context){
    final online=server.status=='online';
    return Padding(
      padding:const EdgeInsets.only(bottom:12),
      child:Card(child:InkWell(
        borderRadius:BorderRadius.circular(18),
        onTap:()=>Navigator.of(context).push(MaterialPageRoute(builder:(_)=>ServerDetailScreen(state:state,server:server))),
        child:Padding(padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
          Row(children:[
            Container(width:10,height:10,decoration:BoxDecoration(shape:BoxShape.circle,color:online?Colors.green:Colors.grey)),
            const SizedBox(width:10),
            Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
              Text(server.name,style:Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight:FontWeight.w800)),
              Text(server.hostname??'Awaiting hostname',style:Theme.of(context).textTheme.bodySmall),
            ])),
            const Icon(Icons.chevron_right_rounded),
          ]),
          const SizedBox(height:14),
          Row(children:[
            Expanded(child:_Usage(label:'CPU',value:server.cpuPercent)),
            Expanded(child:_Usage(label:'RAM',value:server.memoryPercent)),
            Expanded(child:_Usage(label:'Disk',value:server.diskPercent)),
          ]),
        ])),
      )),
    );
  }
}
final class _Usage extends StatelessWidget{
  const _Usage({required this.label,required this.value});final String label;final double? value;
  @override Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
    Text(label,style:Theme.of(context).textTheme.labelSmall),
    const SizedBox(height:3),
    Text(value==null?'—':'${value!.toStringAsFixed(1)}%',style:const TextStyle(fontWeight:FontWeight.w700)),
  ]);
}
