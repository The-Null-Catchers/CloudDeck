import 'package:flutter/material.dart';
import '../app_state.dart';

final class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key,required this.state});
  final AppState state;
  @override State<LoginScreen> createState()=>_LoginScreenState();
}
final class _LoginScreenState extends State<LoginScreen>{
  final _form=GlobalKey<FormState>();
  final _email=TextEditingController();
  final _password=TextEditingController();
  bool _obscure=true;
  @override void dispose(){_email.dispose();_password.dispose();super.dispose();}
  Future<void> _submit() async {if(!_form.currentState!.validate())return;await widget.state.login(_email.text,_password.text);}
  @override Widget build(BuildContext context)=>Scaffold(body:SafeArea(child:Center(child:SingleChildScrollView(
    padding:const EdgeInsets.all(24),child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:460),child:Card(child:Padding(
      padding:const EdgeInsets.all(24),child:Form(key:_form,child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
        Row(children:[Container(width:46,height:46,decoration:BoxDecoration(color:Theme.of(context).colorScheme.primary,borderRadius:BorderRadius.circular(14)),child:const Icon(Icons.cloud_queue_rounded,color:Colors.white)),const SizedBox(width:12),Text('clouddeck.',style:Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight:FontWeight.w800))]),
        const SizedBox(height:28),
        Text('Operations in your pocket',style:Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight:FontWeight.w800)),
        const SizedBox(height:8),
        Text('Monitor servers, alerts, deployments, containers, and logs. Emergency actions stay permission-gated and audited.',style:Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height:28),
        TextFormField(controller:_email,keyboardType:TextInputType.emailAddress,autofillHints:const [AutofillHints.email],decoration:const InputDecoration(labelText:'Email',prefixIcon:Icon(Icons.alternate_email_rounded)),validator:(value)=>value!=null&&value.contains('@')?null:'Enter a valid email'),
        const SizedBox(height:14),
        TextFormField(controller:_password,obscureText:_obscure,autofillHints:const [AutofillHints.password],decoration:InputDecoration(labelText:'Password',prefixIcon:const Icon(Icons.lock_outline_rounded),suffixIcon:IconButton(onPressed:()=>setState(()=>_obscure=!_obscure),icon:Icon(_obscure?Icons.visibility_outlined:Icons.visibility_off_outlined))),validator:(value)=>(value?.length??0)>=12?null:'Password must be at least 12 characters',onFieldSubmitted:(_)=>_submit()),
        if(widget.state.error!=null)...[const SizedBox(height:14),Text(widget.state.error!,style:TextStyle(color:Theme.of(context).colorScheme.error))],
        const SizedBox(height:20),
        FilledButton.icon(onPressed:widget.state.loading?null:_submit,icon:widget.state.loading?const SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.login_rounded),label:Text(widget.state.loading?'Signing in…':'Sign in')),
        const SizedBox(height:14),
        Text('Refresh credentials are stored in device secure storage and rotated by CloudDeck.',textAlign:TextAlign.center,style:Theme.of(context).textTheme.bodySmall),
      ])),
    ))),
  ))));
}
