import 'package:flutter/material.dart';
import '../app_state.dart';

final class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key,required this.state,required this.onOpenServers,required this.onOpenAlerts});
  final AppState state;final VoidCallback onOpenServers,onOpenAlerts;
  @override Widget build(BuildContext context)=>RefreshIndicator(onRefresh:state.refreshOverview,child:ListView(
    padding:const EdgeInsets.fromLTRB(16,16,16,120),children:[
      Text('Infrastructure overview',style:Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight:FontWeight.w800)),
      const SizedBox(height:6),
      Text('Live operational status for ${state.organization?.name??'workspace'}.',style:Theme.of(context).textTheme.bodyMedium),
      if(state.error!=null)...[const SizedBox(height:12),_Notice(text:state.error!)],
      const SizedBox(height:18),
      GridView.count(shrinkWrap:true,physics:const NeverScrollableScrollPhysics(),crossAxisCount:2,mainAxisSpacing:12,crossAxisSpacing:12,childAspectRatio:1.45,children:[
        _MetricCard(icon:Icons.dns_rounded,label:'Servers',value:'${state.stats.total}',onTap:onOpenServers),
        _MetricCard(icon:Icons.check_circle_outline_rounded,label:'Online',value:'${state.stats.online}',onTap:onOpenServers),
        _MetricCard(icon:Icons.cloud_off_outlined,label:'Offline',value:'${state.stats.offline}',critical:state.stats.offline>0,onTap:onOpenServers),
        _MetricCard(icon:Icons.warning_amber_rounded,label:'Open alerts',value:'${state.stats.openAlerts}',critical:state.stats.openAlerts>0,onTap:onOpenAlerts),
      ]),
      const SizedBox(height:24),_SectionTitle(title:'Needs attention',action:'View alerts',onTap:onOpenAlerts),const SizedBox(height:10),
      if(state.alerts.isEmpty)const _Empty(text:'No open alerts. Infrastructure looks healthy.')
      else ...state.alerts.take(4).map((alert)=>Card(child:ListTile(
        leading:CircleAvatar(backgroundColor:Theme.of(context).colorScheme.errorContainer,child:Icon(Icons.warning_amber_rounded,color:Theme.of(context).colorScheme.onErrorContainer)),
        title:Text(alert.resource,style:const TextStyle(fontWeight:FontWeight.w700)),subtitle:Text(alert.kind.replaceAll('_',' ')),trailing:const Icon(Icons.chevron_right_rounded),onTap:onOpenAlerts))),
      const SizedBox(height:24),const _SectionTitle(title:'Recent deployments'),const SizedBox(height:10),
      if(state.deployments.isEmpty)const _Empty(text:'No deployments recorded yet.')
      else ...state.deployments.take(4).map((deployment)=>Card(child:ListTile(
        leading:Icon(deployment.state=='successful'?Icons.check_circle_rounded:deployment.state=='failed'?Icons.cancel_rounded:Icons.sync_rounded),
        title:Text(deployment.applicationName,style:const TextStyle(fontWeight:FontWeight.w700)),subtitle:Text('${deployment.branch} · ${deployment.state}'),
        trailing:Text(deployment.commitSha.length>=7?deployment.commitSha.substring(0,7):deployment.commitSha)))),
    ],
  ));
}
final class _MetricCard extends StatelessWidget{
  const _MetricCard({required this.icon,required this.label,required this.value,this.critical=false,this.onTap});
  final IconData icon;final String label,value;final bool critical;final VoidCallback? onTap;
  @override Widget build(BuildContext context)=>Card(child:InkWell(borderRadius:BorderRadius.circular(18),onTap:onTap,child:Padding(
    padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[
      Icon(icon,color:critical?Theme.of(context).colorScheme.error:Theme.of(context).colorScheme.primary),
      Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(value,style:Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight:FontWeight.w800)),Text(label)]),
    ]),
  )));
}
final class _SectionTitle extends StatelessWidget{
  const _SectionTitle({required this.title,this.action,this.onTap});final String title;final String? action;final VoidCallback? onTap;
  @override Widget build(BuildContext context)=>Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[
    Text(title,style:Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight:FontWeight.w800)),
    if(action!=null)TextButton(onPressed:onTap,child:Text(action!)),
  ]);
}
final class _Empty extends StatelessWidget{
  const _Empty({required this.text});final String text;
  @override Widget build(BuildContext context)=>Card(child:Padding(padding:const EdgeInsets.all(20),child:Row(children:[const Icon(Icons.check_circle_outline_rounded),const SizedBox(width:12),Expanded(child:Text(text))])));
}
final class _Notice extends StatelessWidget{
  const _Notice({required this.text});final String text;
  @override Widget build(BuildContext context)=>Container(padding:const EdgeInsets.all(12),decoration:BoxDecoration(color:Theme.of(context).colorScheme.errorContainer,borderRadius:BorderRadius.circular(12)),child:Text(text));
}
