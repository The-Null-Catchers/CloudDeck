import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../app_state.dart';
import '../core/api_client.dart';
import '../models.dart';

final class ServerDetailScreen extends StatefulWidget{
  const ServerDetailScreen({super.key,required this.state,required this.server});
  final AppState state;final ServerSummary server;
  @override State<ServerDetailScreen> createState()=>_ServerDetailScreenState();
}
final class _ServerDetailScreenState extends State<ServerDetailScreen>{
  String _range='24h';
  late Future<List<MetricPoint>> _metrics;
  late Future<List<ContainerItem>> _containers;
  String? _error;
  @override void initState(){super.initState();_reload();}
  void _reload(){
    _metrics=widget.state.metrics(widget.server.id,range:_range);
    _containers=widget.state.containers(widget.server.id);
  }
  Future<void> _restart(ContainerItem item) async {
    final confirmed=await showDialog<bool>(context:context,builder:(context)=>AlertDialog(
      title:const Text('Restart container?'),
      content:Text('Restart ${item.name}? This action is permission-gated and recorded in CloudDeck audit logs.'),
      actions:[TextButton(onPressed:()=>Navigator.pop(context,false),child:const Text('Cancel')),FilledButton(onPressed:()=>Navigator.pop(context,true),child:const Text('Restart'))],
    ));
    if(confirmed!=true)return;
    try{
      await widget.state.restartContainer(widget.server.id,item.id);
      if(mounted)setState(()=>_containers=widget.state.containers(widget.server.id));
    } on ApiException catch(error){if(mounted)setState(()=>_error=error.message);}
  }
  Future<void> _logs(ContainerItem item) async {
    try{
      final lines=await widget.state.containerLogs(widget.server.id,item.id);
      if(!mounted)return;
      await showModalBottomSheet<void>(
        context:context,isScrollControlled:true,showDragHandle:true,
        builder:(context)=>SafeArea(child:FractionallySizedBox(heightFactor:.78,child:Padding(
          padding:const EdgeInsets.fromLTRB(16,0,16,16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
            Text('${item.name} logs',style:Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight:FontWeight.w800)),
            const SizedBox(height:10),
            Expanded(child:Container(width:double.infinity,padding:const EdgeInsets.all(12),decoration:BoxDecoration(color:Colors.black87,borderRadius:BorderRadius.circular(14)),child:ListView.builder(
              itemCount:lines.length,itemBuilder:(context,index)=>SelectableText(lines[index],style:const TextStyle(color:Colors.white,fontFamily:'monospace',fontSize:12,height:1.45)),
            ))),
          ]),
        ))),
      );
    } on ApiException catch(error){if(mounted)setState(()=>_error=error.message);}
  }
  @override Widget build(BuildContext context)=>Scaffold(
    appBar:AppBar(title:Text(widget.server.name)),
    body:RefreshIndicator(
      onRefresh:() async {setState(_reload);await Future.wait([_metrics,_containers]);},
      child:ListView(padding:const EdgeInsets.fromLTRB(16,8,16,40),children:[
        Row(children:[
          Container(width:10,height:10,decoration:BoxDecoration(shape:BoxShape.circle,color:widget.server.status=='online'?Colors.green:Colors.grey)),
          const SizedBox(width:8),Text(widget.server.status.toUpperCase(),style:Theme.of(context).textTheme.labelLarge),
          const Spacer(),Text(widget.server.hostname??'No hostname'),
        ]),
        if(_error!=null)...[const SizedBox(height:10),Text(_error!,style:TextStyle(color:Theme.of(context).colorScheme.error))],
        const SizedBox(height:18),
        Row(children:['1h','6h','24h','7d'].map((range)=>Padding(
          padding:const EdgeInsets.only(right:8),
          child:ChoiceChip(label:Text(range),selected:_range==range,onSelected:(_){setState((){_range=range;_metrics=widget.state.metrics(widget.server.id,range:_range);});}),
        )).toList()),
        const SizedBox(height:12),
        Card(child:Padding(padding:const EdgeInsets.all(16),child:FutureBuilder<List<MetricPoint>>(
          future:_metrics,builder:(context,snapshot){
            if(snapshot.connectionState!=ConnectionState.done)return const SizedBox(height:180,child:Center(child:CircularProgressIndicator()));
            if(snapshot.hasError)return SizedBox(height:180,child:Center(child:Text('Unable to load metrics')));
            final points=snapshot.data??const [];
            if(points.isEmpty)return const SizedBox(height:180,child:Center(child:Text('No metrics yet')));
            final latest=points.last;
            return Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
              Text('System metrics',style:Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight:FontWeight.w800)),
              const SizedBox(height:12),
              Row(children:[
                Expanded(child:_Metric(label:'CPU',value:latest.cpu)),Expanded(child:_Metric(label:'RAM',value:latest.memory)),Expanded(child:_Metric(label:'Disk',value:latest.disk)),
              ]),
              const SizedBox(height:16),
              SizedBox(height:150,width:double.infinity,child:CustomPaint(painter:_MetricsPainter(points:points,colorScheme:Theme.of(context).colorScheme))),
            ]);
          },
        ))),
        const SizedBox(height:18),
        Text('Docker containers',style:Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight:FontWeight.w800)),
        const SizedBox(height:10),
        FutureBuilder<List<ContainerItem>>(future:_containers,builder:(context,snapshot){
          if(snapshot.connectionState!=ConnectionState.done)return const Center(child:Padding(padding:EdgeInsets.all(30),child:CircularProgressIndicator()));
          if(snapshot.hasError)return const Card(child:Padding(padding:EdgeInsets.all(20),child:Text('Docker is unavailable on this server.')));
          final items=snapshot.data??const [];
          if(items.isEmpty)return const Card(child:Padding(padding:EdgeInsets.all(20),child:Text('No containers reported.')));
          return Column(children:items.map((item)=>Padding(padding:const EdgeInsets.only(bottom:10),child:Card(child:ListTile(
            leading:Icon(item.state=='running'?Icons.play_circle_fill_rounded:Icons.stop_circle_outlined,color:item.state=='running'?Colors.green:Colors.grey),
            title:Text(item.name,style:const TextStyle(fontWeight:FontWeight.w700)),subtitle:Text('${item.image}\n${item.status}',maxLines:2),
            isThreeLine:true,
            trailing:PopupMenuButton<String>(
              onSelected:(action){if(action=='logs')_logs(item);if(action=='restart')_restart(item);},
              itemBuilder:(context)=>[
                const PopupMenuItem(value:'logs',child:Text('View logs')),
                if(widget.state.canOperate&&item.state=='running')const PopupMenuItem(value:'restart',child:Text('Restart')),
              ],
            ),
          )))).toList());
        }),
      ]),
    ),
  );
}
final class _Metric extends StatelessWidget{
  const _Metric({required this.label,required this.value});final String label;final double value;
  @override Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(label,style:Theme.of(context).textTheme.labelSmall),Text('${value.toStringAsFixed(1)}%',style:Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight:FontWeight.w800))]);
}
final class _MetricsPainter extends CustomPainter{
  _MetricsPainter({required this.points,required this.colorScheme});final List<MetricPoint> points;final ColorScheme colorScheme;
  List<Offset> _series(Size size,double Function(MetricPoint) pick){
    final sampled=points.length<=160?points:List.generate(160,(index)=>points[(index*(points.length-1)/159).round()]);
    return List.generate(sampled.length,(index)=>Offset(
      sampled.length==1?0:index/(sampled.length-1)*size.width,
      size.height-(pick(sampled[index]).clamp(0,100)/100*size.height),
    ));
  }
  void _draw(Canvas canvas,Size size,List<Offset> points,Color color){
    if(points.isEmpty)return;final path=Path()..moveTo(points.first.dx,points.first.dy);
    for(final point in points.skip(1)){path.lineTo(point.dx,point.dy);}
    canvas.drawPath(path,Paint()..color=color..style=PaintingStyle.stroke..strokeWidth=2.3..strokeCap=StrokeCap.round..strokeJoin=StrokeJoin.round);
  }
  @override void paint(Canvas canvas,Size size){
    final grid=Paint()..color=colorScheme.outlineVariant.withValues(alpha:.5)..strokeWidth=1;
    for(final ratio in [.25,.5,.75]){canvas.drawLine(Offset(0,size.height*ratio),Offset(size.width,size.height*ratio),grid);}
    _draw(canvas,size,_series(size,(point)=>point.disk),Colors.amber);
    _draw(canvas,size,_series(size,(point)=>point.memory),Colors.teal);
    _draw(canvas,size,_series(size,(point)=>point.cpu),colorScheme.primary);
  }
  @override bool shouldRepaint(covariant _MetricsPainter oldDelegate)=>oldDelegate.points!=points||oldDelegate.colorScheme!=colorScheme;
}
