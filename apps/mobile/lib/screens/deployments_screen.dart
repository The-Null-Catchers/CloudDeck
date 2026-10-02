import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../app_state.dart';

final class DeploymentsScreen extends StatelessWidget{
  const DeploymentsScreen({super.key,required this.state});
  final AppState state;
  @override Widget build(BuildContext context)=>RefreshIndicator(
    onRefresh:state.refreshOverview,
    child:ListView(padding:const EdgeInsets.fromLTRB(16,12,16,120),children:[
      Text('Deployments',style:Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight:FontWeight.w800)),
      const SizedBox(height:6),
      Text('Status-focused mobile view. Deployment configuration remains on the web dashboard.',style:Theme.of(context).textTheme.bodyMedium),
      const SizedBox(height:14),
      if(state.deployments.isEmpty)const Card(child:Padding(padding:EdgeInsets.all(20),child:Text('No deployments recorded.')))
      else ...state.deployments.map((deployment){
        final color=switch(deployment.state){
          'successful'=>Colors.green,
          'failed'=>Theme.of(context).colorScheme.error,
          'cancelled'||'rolled-back'=>Colors.orange,
          _=>Theme.of(context).colorScheme.primary,
        };
        return Padding(padding:const EdgeInsets.only(bottom:10),child:Card(child:Padding(
          padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
            Row(children:[
              Container(width:9,height:9,decoration:BoxDecoration(color:color,shape:BoxShape.circle)),
              const SizedBox(width:10),
              Expanded(child:Text(deployment.applicationName,style:Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight:FontWeight.w800))),
              Text(deployment.state,style:TextStyle(color:color,fontWeight:FontWeight.w700)),
            ]),
            const SizedBox(height:10),
            Wrap(spacing:8,runSpacing:8,children:[
              Chip(label:Text(deployment.branch)),
              if(deployment.commitSha.isNotEmpty)Chip(label:Text(deployment.commitSha.length>=8?deployment.commitSha.substring(0,8):deployment.commitSha)),
            ]),
            const SizedBox(height:6),
            Text(DateFormat.yMMMd().add_Hm().format(deployment.createdAt.toLocal()),style:Theme.of(context).textTheme.bodySmall),
          ]),
        )));
      }),
    ]),
  );
}
