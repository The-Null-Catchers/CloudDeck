import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../app_state.dart';
import '../core/api_client.dart';

final class NotificationsScreen extends StatefulWidget{
  const NotificationsScreen({super.key,required this.state});
  final AppState state;
  @override State<NotificationsScreen> createState()=>_NotificationsScreenState();
}
final class _NotificationsScreenState extends State<NotificationsScreen>{
  String? _busy;
  String? _error;
  Future<void> _read(String id) async {
    setState(()=>_busy=id);
    try{await widget.state.markNotificationRead(id);}
    on ApiException catch(error){if(mounted)setState(()=>_error=error.message);}
    finally{if(mounted)setState(()=>_busy=null);}
  }
  @override Widget build(BuildContext context)=>RefreshIndicator(
    onRefresh:widget.state.refreshOverview,
    child:ListView(padding:const EdgeInsets.fromLTRB(16,12,16,120),children:[
      Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[
        Text('Notifications',style:Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight:FontWeight.w800)),
        Text('${widget.state.unreadNotifications} unread',style:Theme.of(context).textTheme.labelLarge),
      ]),
      if(_error!=null)...[const SizedBox(height:10),Text(_error!,style:TextStyle(color:Theme.of(context).colorScheme.error))],
      const SizedBox(height:14),
      if(widget.state.notifications.isEmpty)const Card(child:Padding(padding:EdgeInsets.all(20),child:Text('No notifications yet.')))
      else ...widget.state.notifications.map((item)=>Padding(
        padding:const EdgeInsets.only(bottom:10),
        child:Card(child:ListTile(
          contentPadding:const EdgeInsets.all(16),
          leading:CircleAvatar(child:Icon(switch(item.type){'critical'=>Icons.error_outline_rounded,'warning'=>Icons.warning_amber_rounded,'security'=>Icons.shield_outlined,'deployment'=>Icons.rocket_launch_outlined,_=>Icons.info_outline_rounded})),
          title:Text(item.title,style:TextStyle(fontWeight:item.readAt==null?FontWeight.w800:FontWeight.w600)),
          subtitle:Padding(padding:const EdgeInsets.only(top:6),child:Text('${item.body}\n${DateFormat.yMMMd().add_Hm().format(item.createdAt.toLocal())}')),
          isThreeLine:true,
          trailing:item.readAt==null?IconButton(
            tooltip:'Mark read',onPressed:_busy==item.id?null:()=>_read(item.id),
            icon:_busy==item.id?const SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.mark_email_read_outlined),
          ):const Icon(Icons.done_all_rounded),
        )),
      )),
    ]),
  );
}
