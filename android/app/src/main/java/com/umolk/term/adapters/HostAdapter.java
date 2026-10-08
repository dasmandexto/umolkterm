package com.umolk.term.adapters;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;
import com.umolk.term.R;
import com.umolk.term.models.SshHost;
import java.util.List;

public class HostAdapter extends RecyclerView.Adapter<HostAdapter.HostViewHolder> {

    public interface OnHostClickListener {
        void onConnect(SshHost host);
        void onTest(SshHost host);
        void onEdit(SshHost host);
        void onDelete(SshHost host);
    }

    private List<SshHost> hostList;
    private OnHostClickListener listener;

    public HostAdapter(List<SshHost> hostList, OnHostClickListener listener) {
        this.hostList = hostList;
        this.listener = listener;
    }

    @NonNull
    @Override
    public HostViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_host_card, parent, false);
        return new HostViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull HostViewHolder holder, int position) {
        SshHost host = hostList.get(position);
        holder.tvHostLabel.setText(host.getLabel());
        holder.tvHostEndpoint.setText(host.getEndpoint());
        holder.tvHostGroup.setText(host.getGroup());
        holder.tvHostStatusDot.setTextColor(host.isOnline() ? 0xFF50FA7B : 0xFF6272A4);

        holder.btnConnect.setOnClickListener(v -> listener.onConnect(host));
        holder.btnTest.setOnClickListener(v -> listener.onTest(host));
        holder.btnEdit.setOnClickListener(v -> listener.onEdit(host));
        holder.btnDelete.setOnClickListener(v -> listener.onDelete(host));
    }

    @Override
    public int getItemCount() {
        return hostList != null ? hostList.size() : 0;
    }

    static class HostViewHolder extends RecyclerView.ViewHolder {
        TextView tvHostStatusDot, tvHostLabel, tvHostEndpoint, tvHostGroup;
        Button btnConnect, btnTest, btnEdit, btnDelete;

        public HostViewHolder(@NonNull View itemView) {
            super(itemView);
            tvHostStatusDot = itemView.findViewById(R.id.tvHostStatusDot);
            tvHostLabel = itemView.findViewById(R.id.tvHostLabel);
            tvHostEndpoint = itemView.findViewById(R.id.tvHostEndpoint);
            tvHostGroup = itemView.findViewById(R.id.tvHostGroup);
            btnConnect = itemView.findViewById(R.id.btnConnectHost);
            btnTest = itemView.findViewById(R.id.btnTestHost);
            btnEdit = itemView.findViewById(R.id.btnEditHost);
            btnDelete = itemView.findViewById(R.id.btnDeleteHost);
        }
    }
}
