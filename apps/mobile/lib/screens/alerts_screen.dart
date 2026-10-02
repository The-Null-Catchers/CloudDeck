import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../app_state.dart';
import '../core/api_client.dart';

final class AlertsScreen extends StatefulWidget{
  const AlertsScreen({super.key,required this.state});
  final AppState state;
  @override State<AlertsScreen> createState()=>_AlertsScreenState();
}
final class _AlertsScreenState extends State<AlertsScreen>{
  String? _busy;
  String? _error;
  Future<void> _acknowledge(String id) async {
    setState(()=>_busy=id);
    try{await widget.state.acknowledgeAlert(id);}
    on ApiException catch(error){if(mounted)setState(()=>_error=error.message);}
    finally{if(mounted)setState(()=>_busy=null);}
  }
  @override Widget build(BuildContext context)=>RefreshIndicator(
    onRefresh:widget.state.refreshOverview,
    child:ListView(padding:const EdgeInsets.fromLTRB(16,12,16,120),children:[
      Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[
        Text('Alerts',style:Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight:FontWeight.w800)),
        Text('${widget.state.alerts.length} open',style:Theme.of(context).textTheme.labelLarge),
      ]),
      if(_error!=null)...[const SizedBox(height:10),Text(_error!,style:TextStyle(color:Theme.of(context).colorScheme.error))],
      const SizedBox(height:14),
      if(widget.state.alerts.isEmpty)const Card(child:Padding(padding:EdgeInsets.all(22),child:Row(children:[Icon(Icons.check_circle_outline_rounded),SizedBox(width:12),Expanded(child:Text('No open alerts.'))])))
      else ...widget.state.alerts.map((alert)=>Padding(
        padding:const EdgeInsets.only(bottom:10),
        child:Card(child:Padding(padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
          Row(children:[
            Icon(Icons.warning_amber_rounded,color:Theme.of(context).colorScheme.error),
            const SizedBox(width:10),
            Expanded(child:Text(alert.resource,style:Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight:FontWeight.w800))),
            Text(alert.state.toUpperCase(),style:Theme.of(context).textTheme.labelSmall),
          ]),
          const SizedBox(height:8),
          Text(alert.kind.replaceAll('_',' ')),
          const SizedBox(height:4),
          Text(DateFormat.yMMMd().add_Hm().format(alert.createdAt.toLocal()),style:Theme.of(context).textTheme.bodySmall),
          if(widget.state.canOperate)...[
            const SizedBox(height:12),
            Align(alignment:Alignment.centerRight,child:OutlinedButton.icon(
              onPressed:_busy==alert.id?null:()=>_acknowledge(alert.id),
              icon:_busy==alert.id?const SizedBox(width:16,height:16,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.done_rounded),
              label:const Text('Acknowledge'),
            )),
          ],
        ]))),
      )),
    ]),
  );
}
