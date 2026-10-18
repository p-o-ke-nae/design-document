namespace OrderApp.WinForms.Screens;

partial class InputScreen
{
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Component Designer generated code

    private void InitializeComponent()
    {
        this.components = new System.ComponentModel.Container();
        this.title = new System.Windows.Forms.Label();
        this.customerLabel = new System.Windows.Forms.Label();
        this.customer = new System.Windows.Forms.TextBox();
        this.skuLabel = new System.Windows.Forms.Label();
        this.sku = new System.Windows.Forms.ListBox();
        this.quantityLabel = new System.Windows.Forms.Label();
        this.quantity = new System.Windows.Forms.TextBox();
        this.error = new System.Windows.Forms.Label();
        this.cancel = new System.Windows.Forms.Button();
        this.next = new System.Windows.Forms.Button();
        this.errorTip = new System.Windows.Forms.ToolTip(this.components);
        this.SuspendLayout();
        //
        // title
        //
        this.title.AutoSize = true;
        this.title.Font = new System.Drawing.Font("Yu Gothic UI", 13F, System.Drawing.FontStyle.Bold);
        this.title.Location = new System.Drawing.Point(0, 0);
        this.title.Name = "title";
        this.title.Size = new System.Drawing.Size(82, 25);
        this.title.TabIndex = 0;
        this.title.Text = "注文入力";
        //
        // customerLabel
        //
        this.customerLabel.AutoSize = true;
        this.customerLabel.Location = new System.Drawing.Point(0, 43);
        this.customerLabel.Name = "customerLabel";
        this.customerLabel.Size = new System.Drawing.Size(43, 15);
        this.customerLabel.TabIndex = 1;
        this.customerLabel.Text = "顧客名";
        //
        // customer
        //
        this.customer.Location = new System.Drawing.Point(80, 40);
        this.customer.MaxLength = 50;
        this.customer.Name = "customer";
        this.customer.Size = new System.Drawing.Size(320, 23);
        this.customer.TabIndex = 2;
        //
        // skuLabel
        //
        this.skuLabel.AutoSize = true;
        this.skuLabel.Location = new System.Drawing.Point(0, 79);
        this.skuLabel.Name = "skuLabel";
        this.skuLabel.Size = new System.Drawing.Size(31, 15);
        this.skuLabel.TabIndex = 3;
        this.skuLabel.Text = "商品";
        //
        // sku
        //
        this.sku.IntegralHeight = false;
        this.sku.Location = new System.Drawing.Point(80, 76);
        this.sku.Name = "sku";
        this.sku.Size = new System.Drawing.Size(160, 40);
        this.sku.TabIndex = 4;
        //
        // quantityLabel
        //
        this.quantityLabel.AutoSize = true;
        this.quantityLabel.Location = new System.Drawing.Point(0, 131);
        this.quantityLabel.Name = "quantityLabel";
        this.quantityLabel.Size = new System.Drawing.Size(31, 15);
        this.quantityLabel.TabIndex = 5;
        this.quantityLabel.Text = "数量";
        //
        // quantity
        //
        this.quantity.Location = new System.Drawing.Point(80, 128);
        this.quantity.Name = "quantity";
        this.quantity.Size = new System.Drawing.Size(80, 23);
        this.quantity.TabIndex = 6;
        //
        // error
        //
        this.error.AutoSize = true;
        this.error.ForeColor = System.Drawing.Color.FromArgb(185, 28, 28);
        this.error.Location = new System.Drawing.Point(0, 164);
        this.error.Name = "error";
        this.error.Size = new System.Drawing.Size(150, 15);
        this.error.TabIndex = 7;
        this.error.Text = "入力内容を確認してください";
        this.error.Visible = false;
        //
        // cancel
        //
        this.cancel.Location = new System.Drawing.Point(0, 192);
        this.cancel.Name = "cancel";
        this.cancel.Size = new System.Drawing.Size(96, 30);
        this.cancel.TabIndex = 8;
        this.cancel.Text = "キャンセル";
        this.cancel.UseVisualStyleBackColor = true;
        this.cancel.Click += new System.EventHandler(this.cancel_Click);
        //
        // next
        //
        this.next.Location = new System.Drawing.Point(104, 192);
        this.next.Name = "next";
        this.next.Size = new System.Drawing.Size(96, 30);
        this.next.TabIndex = 9;
        this.next.Text = "次へ";
        this.next.UseVisualStyleBackColor = true;
        this.next.Click += new System.EventHandler(this.next_Click);
        //
        // InputScreen
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.Controls.Add(this.title);
        this.Controls.Add(this.customerLabel);
        this.Controls.Add(this.customer);
        this.Controls.Add(this.skuLabel);
        this.Controls.Add(this.sku);
        this.Controls.Add(this.quantityLabel);
        this.Controls.Add(this.quantity);
        this.Controls.Add(this.error);
        this.Controls.Add(this.cancel);
        this.Controls.Add(this.next);
        this.Name = "Input";
        this.Size = new System.Drawing.Size(592, 365);
        this.ResumeLayout(false);
        this.PerformLayout();
    }

    #endregion

    private System.Windows.Forms.Label title;
    private System.Windows.Forms.Label customerLabel;
    private System.Windows.Forms.TextBox customer;
    private System.Windows.Forms.Label skuLabel;
    private System.Windows.Forms.ListBox sku;
    private System.Windows.Forms.Label quantityLabel;
    private System.Windows.Forms.TextBox quantity;
    private System.Windows.Forms.Label error;
    private System.Windows.Forms.Button cancel;
    private System.Windows.Forms.Button next;
    private System.Windows.Forms.ToolTip errorTip;
}
