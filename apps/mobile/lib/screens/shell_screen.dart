import 'dart:async';

import 'package:flutter/material.dart';
import '../app_state.dart';
import '../core/push_notifications.dart';
import 'alerts_screen.dart';
import 'dashboard_screen.dart';
import 'deployments_screen.dart';
import 'notifications_screen.dart';
import 'server_detail_screen.dart';
import 'servers_screen.dart';

final class ShellScreen extends StatefulWidget {
  const ShellScreen({super.key,required this.state});
  final AppState state;
  @override State<ShellScreen> createState()=>_ShellScreenState();
}
final class _ShellScreenState extends State<ShellScreen>{
  int _index=0;
  StreamSubscription<PushNavigationIntent>? _pushNavigation;

  @override
  void initState(){
    super.initState();
    _pushNavigation=widget.state.push.navigation.listen(_openPushIntent);
    final pending=widget.state.push.takePendingNavigation();
    if(pending!=null){
      WidgetsBinding.instance.addPostFrameCallback((_){if(mounted)_openPushIntent(pending);});
    }
  }

  void _openPushIntent(PushNavigationIntent intent){
    if(!mounted)return;
    final uri=intent.href==null?null:Uri.tryParse(intent.href!);
    final segments=uri?.pathSegments.where((segment)=>segment.isNotEmpty).toList(growable:false)??const <String>[];
    final serverIndex=segments.indexOf('servers');
    if(serverIndex>=0){
      setState(()=>_index=1);
      final serverId=serverIndex+1<segments.length?segments[serverIndex+1]:null;
      if(serverId!=null){
        final matches=widget.state.servers.where((server)=>server.id==serverId);
        if(matches.isNotEmpty){
          Navigator.of(context).push(MaterialPageRoute(
            builder:(_)=>ServerDetailScreen(state:widget.state,server:matches.first),
          ));
        }
      }
      return;
    }
    if(segments.contains('deployments')||intent.type=='deployment'){
      setState(()=>_index=3);
      return;
    }
    if(segments.contains('alerts')||const {'critical','warning'}.contains(intent.type)){
      setState(()=>_index=2);
      return;
    }
    if(segments.contains('notifications')){
      setState(()=>_index=4);
      return;
    }
    setState(()=>_index=4);
  }

  @override
  void dispose(){
    unawaited(_pushNavigation?.cancel());
    super.dispose();
  }

  @override Widget build(BuildContext context){
    final pages=[
      DashboardScreen(state:widget.state,onOpenServers:()=>setState(()=>_index=1),onOpenAlerts:()=>setState(()=>_index=2)),
      ServersScreen(state:widget.state),AlertsScreen(state:widget.state),DeploymentsScreen(state:widget.state),NotificationsScreen(state:widget.state),
    ];
    return Scaffold(
      appBar:AppBar(title:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
        const Text('clouddeck.',style:TextStyle(fontWeight:FontWeight.w800)),
        if(widget.state.organization!=null)Text(widget.state.organization!.name,style:Theme.of(context).textTheme.labelSmall),
      ]),actions:[
        if(widget.state.organizations.length>1)PopupMenuButton<String>(
          tooltip:'Workspace',icon:const Icon(Icons.domain_outlined),
          onSelected:(id){final next=widget.state.organizations.firstWhere((item)=>item.id==id);widget.state.selectOrganization(next);},
          itemBuilder:(context)=>widget.state.organizations.map((item)=>PopupMenuItem(value:item.id,child:Text(item.name))).toList(),
        ),
        IconButton(onPressed:widget.state.loading?null:widget.state.refreshOverview,icon:const Icon(Icons.refresh_rounded),tooltip:'Refresh'),
        PopupMenuButton<String>(onSelected:(value){if(value=='logout')widget.state.logout();},itemBuilder:(context)=>const [PopupMenuItem(value:'logout',child:Text('Sign out'))]),
      ]),
      body:SafeArea(child:IndexedStack(index:_index,children:pages)),
      bottomNavigationBar:NavigationBar(selectedIndex:_index,onDestinationSelected:(value)=>setState(()=>_index=value),destinations:[
        const NavigationDestination(icon:Icon(Icons.dashboard_outlined),selectedIcon:Icon(Icons.dashboard_rounded),label:'Overview'),
        const NavigationDestination(icon:Icon(Icons.dns_outlined),selectedIcon:Icon(Icons.dns_rounded),label:'Servers'),
        NavigationDestination(icon:Badge(isLabelVisible:widget.state.alerts.isNotEmpty,label:Text('${widget.state.alerts.length}'),child:const Icon(Icons.warning_amber_outlined)),selectedIcon:const Icon(Icons.warning_amber_rounded),label:'Alerts'),
        const NavigationDestination(icon:Icon(Icons.rocket_launch_outlined),selectedIcon:Icon(Icons.rocket_launch_rounded),label:'Deployments'),
        NavigationDestination(icon:Badge(isLabelVisible:widget.state.unreadNotifications>0,label:Text('${widget.state.unreadNotifications}'),child:const Icon(Icons.notifications_outlined)),selectedIcon:const Icon(Icons.notifications_rounded),label:'Inbox'),
      ]),
    );
  }
}
