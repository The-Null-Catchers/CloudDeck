final class Organization {
  const Organization({required this.id, required this.name, required this.role});
  final String id;
  final String name;
  final String role;
  factory Organization.fromJson(Map<String, dynamic> json) => Organization(
    id: json['id'] as String, name: json['name'] as String, role: json['role'] as String);
}
final class DashboardStats {
  const DashboardStats({required this.total,required this.online,required this.offline,required this.openAlerts});
  final int total,online,offline,openAlerts;
  factory DashboardStats.fromJson(Map<String,dynamic> json)=>DashboardStats(
    total:(json['total'] as num?)?.toInt()??0,online:(json['online'] as num?)?.toInt()??0,
    offline:(json['offline'] as num?)?.toInt()??0,openAlerts:(json['openAlerts'] as num?)?.toInt()??0);
}
final class ServerSummary {
  const ServerSummary({required this.id,required this.name,required this.status,this.hostname,this.lastSeenAt,this.cpuPercent,this.memoryPercent,this.diskPercent});
  final String id,name,status; final String? hostname; final DateTime? lastSeenAt; final double? cpuPercent,memoryPercent,diskPercent;
  factory ServerSummary.fromJson(Map<String,dynamic> json)=>ServerSummary(
    id:json['id'] as String,name:json['name'] as String,status:json['status'] as String? ?? 'unknown',
    hostname:json['hostname'] as String?,lastSeenAt:DateTime.tryParse(json['lastSeenAt'] as String? ?? ''),
    cpuPercent:(json['cpuPercent'] as num?)?.toDouble(),memoryPercent:(json['memoryPercent'] as num?)?.toDouble(),
    diskPercent:(json['diskPercent'] as num?)?.toDouble());
}
final class MetricPoint {
  const MetricPoint({required this.at,required this.cpu,required this.memory,required this.disk,required this.load});
  final DateTime at; final double cpu,memory,disk,load;
  factory MetricPoint.fromJson(Map<String,dynamic> json)=>MetricPoint(
    at:DateTime.parse(json['bucket_at'] as String),cpu:(json['cpu_percent'] as num).toDouble(),
    memory:(json['memory_percent'] as num).toDouble(),disk:(json['disk_percent'] as num).toDouble(),
    load:(json['load_1'] as num?)?.toDouble()??0);
}
final class AlertItem {
  const AlertItem({required this.id,required this.kind,required this.state,required this.createdAt,this.serverName,this.healthCheckName,this.domainHostname});
  final String id,kind,state; final DateTime createdAt; final String? serverName,healthCheckName,domainHostname;
  factory AlertItem.fromJson(Map<String,dynamic> json)=>AlertItem(
    id:json['id'] as String,kind:json['kind'] as String,state:json['state'] as String,
    createdAt:DateTime.parse(json['created_at'] as String),serverName:json['server_name'] as String?,
    healthCheckName:json['health_check_name'] as String?,domainHostname:json['domain_hostname'] as String?);
  String get resource=>serverName??healthCheckName??domainHostname??'Infrastructure';
}
final class DeploymentItem {
  const DeploymentItem({required this.id,required this.applicationName,required this.state,required this.branch,required this.commitSha,required this.createdAt});
  final String id,applicationName,state,branch,commitSha; final DateTime createdAt;
  factory DeploymentItem.fromJson(Map<String,dynamic> json)=>DeploymentItem(
    id:json['id'] as String,applicationName:json['application_name'] as String? ?? 'Application',
    state:json['state'] as String,branch:json['branch'] as String? ?? '—',commitSha:json['commit_sha'] as String? ?? '',
    createdAt:DateTime.parse(json['created_at'] as String));
}
final class NotificationItem {
  const NotificationItem({required this.id,required this.type,required this.title,required this.body,required this.createdAt,this.readAt});
  final String id,type,title,body; final DateTime createdAt; final DateTime? readAt;
  factory NotificationItem.fromJson(Map<String,dynamic> json)=>NotificationItem(
    id:json['id'] as String,type:json['type'] as String,title:json['title'] as String,body:json['body'] as String,
    createdAt:DateTime.parse(json['created_at'] as String),readAt:DateTime.tryParse(json['read_at'] as String? ?? ''));
}
final class ContainerItem {
  const ContainerItem({required this.id,required this.name,required this.image,required this.state,required this.status});
  final String id,name,image,state,status;
  factory ContainerItem.fromJson(Map<String,dynamic> json)=>ContainerItem(
    id:json['id'] as String,name:json['name'] as String,image:json['image'] as String,
    state:json['state'] as String,status:json['status'] as String);
}
